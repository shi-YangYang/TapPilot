#!/usr/bin/env node
// No LLM, no input injection, no mutation replay: actual Android observations and independent business oracle.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeEntry, observation, target, stableSetupTree, until } from './native-executor-eval.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : undefined;

function argumentsOf(argv) {
  const result = { entries: 'desktop,mcp', seeds: '17' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') result.help = true;
    else if (['--serial', '--entries', '--scenes', '--seeds', '--output'].includes(argv[i]) && argv[i + 1]) result[argv[i].slice(2)] = argv[++i];
    else fail('INVALID_ARGUMENT');
  }
  return result;
}

function isFull(tree, packageName) {
  return tree?.executor === 'node-v1' && tree.observationContract === 'semantic-v1' && tree.packageName === packageName &&
    typeof tree.snapshotId === 'string' && Number.isSafeInteger(tree.revision) && Array.isArray(tree.nodes);
}

function hasTarget(tree, id) {
  try { target(tree, id); return true; } catch { return false; }
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/semantic-observation-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes semantic_event_noise,semantic_blank] [--seeds 17,29,43] [--output /tmp/semantic-report.json]');
    console.log('Requires pre-authorized production/testbed debug APKs. Only isolated emulators, no model calls or system permission changes.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry)) || new Set(entries).size !== entries.length) fail('INVALID_ENTRY');
  const seeds = args.seeds.split(',').map(Number);
  if (!seeds.length || seeds.length > 10 || seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 100_000) || new Set(seeds).size !== seeds.length) fail('INVALID_SEED');
  const definition = JSON.parse(await readFile(path.join(root, 'android/testbed/semantic-scenarios.json'), 'utf8'));
  const scenes = args.scenes?.split(',') ?? definition.scenarios.map(scene => scene.id);
  if (!scenes.length || new Set(scenes).size !== scenes.length || scenes.some(id => !definition.scenarios.some(scene => scene.id === id))) fail('UNKNOWN_FIXTURE');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const reports = [];
  for (const entry of entries) for (const id of scenes) for (const seed of seeds) {
    const scenario = definition.scenarios.find(scene => scene.id === id);
    const runId = randomUUID();
    const started = performance.now();
    const checks = [];
    const check = (code, predicate) => { if (!predicate) checks.push(code); };
    let client, fixtureError, actual, baseline, result, armObservationError, armAccepted, actionCalls = 0, waitCalls = 0, waitDurationMs = 0, eventCountBefore = 0;
    const oracle = async () => {
      try {
        const state = JSON.parse(await adb('exec-out', 'run-as', definition.package, 'cat', definition.oraclePath));
        return state.schemaVersion === 1 && state.runId === runId && state.scene === id && state.seed === seed ? state : undefined;
      } catch { return undefined; }
    };
    try {
      // The only ADB mutation resets this app-private synthetic fixture on an explicitly named emulator.
      await adb('shell', 'am', 'start', '-S', '-n', definition.activity, '--es', 'scene', id, '--ei', 'seed', String(seed), '--es', 'runId', runId);
      await until(async () => {
        const state = await oracle();
        return state?.page === 'semantic_ready' && state.completed === false && state.clickCount === 0 && state;
      });
      client = await createNativeEntry(entry, { adbPath, serial: args.serial });
      await until(async () => {
        const current = await client.call('get_current_app', {});
        return current.ok === true && current.result?.packageName === definition.package;
      });
      const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
      if (!read.ok) fail('FIXTURE_READ_FAILED');
      baseline = await stableSetupTree(client, observation(read), scenario.target ? [scenario.target] : []);
      if (!isFull(baseline, definition.package)) fail('SEMANTIC_OBSERVATION_REQUIRED');
      if (scenario.minNodes) {
        check('LARGE_BASELINE_TOO_SMALL', baseline.nodes.length >= scenario.minNodes);
        check('LARGE_BASELINE_TRUNCATED', baseline.truncated === false);
      }
      if (scenario.armed) {
        actionCalls++;
        const armed = await client.call('act_and_observe', { action: 'tap_element', arguments: target(baseline, 'semantic_arm'), waitMs: 200 });
        armAccepted = armed.result?.action?.accepted === true;
        armObservationError = safeCode(armed.result?.observationError?.code);
        if (!armed.ok || armed.result?.action?.accepted !== true) fail('FIXTURE_ARM_FAILED');
        baseline = observation(armed);
        const state = await oracle();
        if (!state?.armed || state.changed) fail('FIXTURE_CHANGE_TOO_EARLY');
        check('ARM_REPORTED_VERIFIED', armed.result?.execution?.verification === 'unverified');
        if (scenario.kind === 'wait_recovery') check('EMPTY_BASELINE_NOT_UNAVAILABLE', baseline?.quality?.status === 'unavailable');
        if (!isFull(baseline, definition.package)) fail('ARM_BASELINE_OBSERVATION_MISSING');
      }

      if (scenario.kind.startsWith('wait_')) {
        const selectorId = scenario.kind === 'wait_visible' ? 'semantic_target' : scenario.kind === 'wait_match' ? 'semantic_result' : undefined;
        eventCountBefore = (await oracle())?.eventCount ?? 0;
        const waitStarted = performance.now();
        waitCalls++;
        result = await client.call('wait_for_ui_change', {
          snapshotId: baseline.snapshotId, sinceRevision: baseline.revision, timeoutMs: scenario.timeoutMs,
          ...(selectorId ? { selector: { resourceId: `${definition.package}:id/${selectorId}` } } : {}),
        });
        waitDurationMs = Math.round(performance.now() - waitStarted);
        const current = observation(result);
        check('WAIT_NOT_SUCCESSFUL', result?.ok === true);
        check('WAIT_MISSING_FULL_OBSERVATION', isFull(current, definition.package));
        check('WAIT_NOT_SEMANTIC', current?.wait?.mode === 'semantic');
        const expectedStatus = scenario.kind === 'wait_noise' ? 'timed_out' : scenario.kind === 'wait_window' ? 'window_changed' : selectorId ? 'matched' : 'changed';
        check('WAIT_WRONG_STATUS', current?.wait?.status === expectedStatus);
        check('WAIT_WRONG_TIMEOUT', current?.timedOut === (scenario.kind === 'wait_noise'));
        check('WAIT_WRONG_MATCH', current?.matched === Boolean(selectorId));
        // A selector can already match while unrelated focus/geometry also changes.
        // Match semantics do not promise an unchanged whole screen; the dedicated
        // noise fixture below is the strict unchanged-observation regression.
        if (scenario.kind === 'wait_visible') {
          check('WAIT_INCONSISTENT_SEMANTIC_CHANGE', typeof current?.changed === 'boolean' && current.changed === current?.wait?.semanticChanged);
        } else {
          const expectedChange = scenario.kind !== 'wait_noise';
          check('WAIT_WRONG_SEMANTIC_CHANGE', current?.changed === expectedChange && current?.wait?.semanticChanged === expectedChange);
        }
        check('WAIT_EXCEEDED_BOUND', waitDurationMs <= scenario.timeoutMs + 3_000);
        if (scenario.kind === 'wait_noise') {
          check('NOISE_RETURNED_EARLY', waitDurationMs >= scenario.timeoutMs - 100);
          check('NO_EVENT_REACHED_SERVICE', current?.revision > baseline.revision);
          check('NOISE_CHANGED_WINDOW', current?.windowId === baseline.windowId);
          if (scenario.minNodes) {
            check('WAIT_CHANGED_CAPTURE_BUDGET', current?.nodes?.length === baseline.nodes.length && current?.truncated === false);
          }
        } else if (scenario.kind === 'wait_window') {
          check('WINDOW_ID_UNCHANGED', current?.windowId !== baseline.windowId);
        } else if (scenario.kind !== 'wait_visible') {
          check('WAIT_MISSING_EXPECTED_CONTENT', hasTarget(current, 'semantic_result'));
          check('RECOVERED_TREE_NOT_USABLE', current?.quality?.status === 'usable');
        } else {
          check('VISIBLE_SELECTOR_WAITED_FOR_EVENT', waitDurationMs < scenario.timeoutMs);
          check('MATCHED_TREE_MISSING_TARGET', hasTarget(current, 'semantic_target'));
        }
      } else if (scenario.kind.startsWith('action_')) {
        const input = scenario.kind === 'action_input';
        actionCalls++;
        result = await client.call('act_and_observe', {
          action: input ? 'input_text' : 'tap_element',
          arguments: { ...target(baseline, scenario.target), ...(input ? { text: '中文输入验证' } : {}) }, waitMs: 200,
        });
        const execution = result?.result?.execution;
        check('ACTION_NOT_ACCEPTED', result?.ok === true && result?.result?.action?.accepted === true);
        check('ACTION_MISSING_OBSERVATION', isFull(observation(result), definition.package));
        check('ACTION_WRONG_EXECUTION_EVIDENCE', execution?.dispatch === 'sent' && execution?.acceptance === 'accepted');
        if (input) {
          check('INPUT_NOT_NATIVE_VERIFIED', result?.result?.action?.textVerified === true && execution?.verification === 'verified');
        } else {
          check('NOOP_REPORTED_VERIFIED', execution?.verification === 'unverified');
          check('NOOP_REPORTED_CHANGED', execution?.effect === 'unchanged');
        }
      } else if (scenario.kind === 'quality_empty') {
        check('EMPTY_TREE_NOT_UNAVAILABLE', baseline.quality?.status === 'unavailable' && baseline.quality?.reason === 'no_accessible_content');
        check('EMPTY_TREE_HAS_CONTENT', baseline.quality?.actionableCount === 0 && baseline.quality?.readableCount === 0);
        check('EMPTY_TREE_NOT_PRESENT', baseline.nodes.length > 0);
      } else if (scenario.kind === 'quality_text') {
        check('TEXT_ONLY_NOT_USABLE', baseline.quality?.status === 'usable' && baseline.quality?.reason === 'accessible_content');
        check('TEXT_ONLY_WRONG_COUNTS', baseline.quality?.actionableCount === 0 && baseline.quality?.readableCount > 0);
      }
      actual = await until(async () => await oracle());
      check('WRONG_BUSINESS_CLICK', actual.wrongClicks === 0);
      check('UNEXPECTED_BUSINESS_COMPLETION', actual.completed === (scenario.kind === 'action_input'));
      check('DUPLICATE_OR_UNEXPECTED_CLICK', actual.clickCount === (scenario.kind === 'action_noop' ? 1 : 0));
      check('UNEXPECTED_INPUT', scenario.kind === 'action_input' ? actual.receivedInput === 'expected' && actual.inputField === 'semantic_field' : actual.receivedInput === 'none');
      if (scenario.armed) check('FIXTURE_MUTATION_NOT_OBSERVED', actual.armed && actual.changed && actual.effectCount === 1);
      if (scenario.kind === 'wait_noise') check('INSUFFICIENT_EVENT_NOISE', actual.eventCount >= eventCountBefore + 5 && actual.changed === false && actual.effectCount === 0);
    } catch (error) { fixtureError = safeCode(error.message) ?? 'SEMANTIC_FIXTURE_FAILED'; }
    finally { actual ??= await oracle(); await client?.close(); }
    const current = observation(result) ?? baseline;
    const report = {
      entry, scene: id, seed, status: !fixtureError && checks.length === 0 ? 'success' : 'failed',
      modelCalls: 0, actionCalls, waitCalls, waitDurationMs, durationMs: Math.round(performance.now() - started),
      clickCount: actual?.clickCount ?? null, wrongClicks: actual?.wrongClicks ?? null,
      eventCount: actual?.eventCount ?? null, eventRevisionDelta: baseline && current ? current.revision - baseline.revision : null,
      qualityStatus: current?.quality?.status ?? null, qualityReason: current?.quality?.reason ?? null,
      actionableCount: current?.quality?.actionableCount ?? null, readableCount: current?.quality?.readableCount ?? null,
      baselineNodeCount: baseline?.nodes?.length ?? null, returnedNodeCount: current?.nodes?.length ?? null,
      waitStatus: current?.wait?.status ?? null, semanticChanged: current?.wait?.semanticChanged ?? null,
      verification: result?.result?.execution?.verification ?? null, effect: result?.result?.execution?.effect ?? null,
      observationScope: current ? current.packageName === definition.package ? 'fixture' : 'other' : 'absent',
      ...(armAccepted !== undefined ? { armAccepted } : {}), ...(armObservationError ? { armObservationError } : {}),
      ...(safeCode(result?.result?.observationError?.code) ? { observationError: result.result.observationError.code } : {}),
      checks, ...(fixtureError ? { fixtureError } : {}), ...(safeCode(result?.error?.code) ? { errorCode: result.error.code } : {}),
    };
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  const summary = { schemaVersion: 1, cases: reports.length, modelCalls: 0, success: reports.filter(item => item.status === 'success').length,
    failed: reports.filter(item => item.status === 'failed').length, reports };
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, reports: undefined }));
  if (summary.failed) process.exitCode = 1;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error.message) ?? 'SEMANTIC_OBSERVATION_EVAL_FAILED'); process.exitCode = 1; });
}
