#!/usr/bin/env node
// One set_text, its returned observation, then one retained-snapshot tap.
// No model, supplementary UI read, coordinate input or mutation replay.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeEntry, observation, target } from './native-executor-eval.mjs';
import { acquireDeviceLease } from './testbed-batch.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Only fixture launch/layout preparation. No input exists yet, so neither the
// TextWatcher clock nor the delayed side effects have started during this wait.
const fixturePrepareMs = 1000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value) ? value : undefined;
const count = value => Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
const choice = (value, values) => values.includes(value) ? value : null;
const resource = (node, id) => [node.resourceId, node.rid].some(value => typeof value === 'string' &&
  (value.endsWith(`:id/${id}`) || value.endsWith(`/id/${id}`) || value === `id/${id}`));
const node = (tree, id) => {
  const found = (tree?.nodes ?? []).filter(item => resource(item, id) && item.visible !== false);
  return found.length === 1 ? found[0] : undefined;
};
const sameBounds = (a, b) => Array.isArray(a?.bounds) && a.bounds.length === 4 &&
  Array.isArray(b?.bounds) && a.bounds.every((value, index) => value === b.bounds[index]);
const height = value => Array.isArray(value?.bounds) && value.bounds.length === 4 ? value.bounds[3] - value.bounds[1] : null;
const readiness = value => value ? { status: choice(value.status, ['ready', 'settling']),
  reason: choice(value.reason, ['interaction_stable', 'known_window', 'deadline']),
  samples: count(value.samples), waitedMs: count(value.waitedMs) } : null;
const execution = value => ({
  dispatch: choice(value?.result?.execution?.dispatch ?? value?.error?.details?.dispatchState, ['sent', 'not_sent', 'unknown']),
  verification: choice(value?.result?.execution?.verification, ['verified', 'unverified']),
  ...(safeCode(value?.error?.code) ? { errorCode: value.error.code } : {}),
  ...(safeCode(value?.error?.details?.reason) ? { reason: value.error.details.reason } : {}),
});

function argumentsOf(argv) {
  const args = { entries: 'desktop,mcp', 'wait-ms': '350' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') args.help = true;
    else if (['--serial', '--entries', '--scenes', '--wait-ms', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!['0', '350'].includes(args['wait-ms'])) fail('INVALID_WAIT_MS');
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/input-settling-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes input_enabled_500,input_geometry_800,input_refresh_forever] [--wait-ms 350|0] [--output /tmp/input-settling.json]');
    console.log('Default: one input must return final delayed side effects; retain that exact snapshot for 3 seconds, then tap Search once. Permanent refresh must return bounded settling and safely refuse the retained snapshot. --wait-ms 0 checks one immediate unverified observation only. Requires the current testbed APK; the receiver may be old for a before run.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry))) fail('INVALID_ENTRY');
  const definition = JSON.parse(await readFile(path.join(root, 'android/testbed/input-settling-scenarios.json'), 'utf8'));
  const scenes = args.scenes?.split(',') ?? definition.scenarios.map(scene => scene.id);
  if (!scenes.length || new Set(scenes).size !== scenes.length || scenes.some(id => !definition.scenarios.some(scene => scene.id === id))) fail('UNKNOWN_FIXTURE');
  const waitMs = Number(args['wait-ms']);
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const lease = await acquireDeviceLease({ serial: args.serial, runId: randomUUID() });
  const reports = [];
  try {
    for (const entry of entries) for (const scene of scenes) {
      const scenario = definition.scenarios.find(item => item.id === scene);
      const runId = randomUUID(), started = performance.now(), checks = [];
      const check = (code, predicate) => { if (!predicate) checks.push(code); };
      let client, initial, returned, response, followup, returnedOracle, actual, error;
      let stage = 'connect', inputCalls = 0, targetCalls = 0, uiReads = 0, inputMs = 0, targetMs = 0, thoughtMs = 0;
      const oracle = async () => {
        const value = JSON.parse(await adb('exec-out', 'run-as', definition.package, 'cat', definition.oraclePath));
        if (value.schemaVersion !== 1 || value.runId !== runId || value.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
        return value;
      };
      try {
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        if ((await client.call('get_device_info', {})).ok !== true) fail('RECEIVER_NOT_CONNECTED');
        stage = 'launch';
        await adb('shell', 'am', 'start', '-W', '-S', '-n', definition.activity, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '41');
        const foregroundDeadline = Date.now() + 5000;
        let foreground = false;
        do {
          const current = await client.call('get_current_app', {});
          if (current.ok === true && current.result?.packageName === definition.package) { foreground = true; break; }
          if (current.ok !== true && !['NO_ACTIVE_WINDOW', 'STALE_SNAPSHOT', 'PROTECTED_APP'].includes(current.error?.code)) fail('FIXTURE_FOREGROUND_FAILED');
          await pause(30);
        } while (Date.now() < foregroundDeadline);
        if (!foreground) fail('FIXTURE_NOT_FOREGROUND');
        stage = 'fixture_launch_preparation';
        await pause(fixturePrepareMs);
        const before = await oracle();
        if (before.inputApplied !== false || before.sideEffectReady !== false || before.clickCount !== 0 || before.expectedInputCount !== 0) fail('SETUP_ALREADY_ACTED');
        stage = 'initial_ready';
        uiReads++;
        const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        if (read.ok !== true) fail(safeCode(read.error?.code) ?? 'INITIAL_READ_FAILED');
        initial = observation(read);
        if (initial?.packageName !== definition.package || initial.readiness?.status !== 'ready' || !Array.isArray(initial.nodes)) fail('INITIAL_WINDOW_NOT_READY');
        if (node(initial, 'input_settling_save')?.enabled !== false || node(initial, 'input_settling_undo')?.enabled !== false) fail('INITIAL_SIDE_EFFECT_NOT_PENDING');
        stage = 'single_input';
        inputCalls++;
        const inputStarted = performance.now();
        response = await client.call('act_and_observe', { action: 'input_text', arguments: {
          ...target(initial, 'input_settling_editor'), text: '合成输入验证',
        }, waitMs });
        inputMs = Math.round(performance.now() - inputStarted);
        returned = observation(response);
        if (response.ok !== true || response.result?.action?.accepted !== true || response.result?.execution?.dispatch !== 'sent') {
          fail(safeCode(response.error?.code) ?? 'INPUT_NOT_SENT');
        }
        // No later read is allowed to repair missing side effects in THIS tree.
        stage = 'input_response_verification';
        returnedOracle = await oracle();
        check('INPUT_NOT_APPLIED_ONCE', returnedOracle.inputApplied === true && returnedOracle.inputValueMatches === true && returnedOracle.expectedInputCount === 1);
        check('INPUT_VALUE_MISSING_FROM_RESPONSE', node(returned, 'input_settling_editor')?.text === '合成输入验证');
        check('INPUT_OBSERVATION_MISSING', returned?.packageName === definition.package && Array.isArray(returned?.nodes));
        check('WINDOW_CHANGED', Number.isInteger(initial.windowId) && returned?.windowId === initial.windowId);
        check('STABLE_TARGET_MOVED', sameBounds(node(initial, 'input_settling_search'), node(returned, 'input_settling_search')));
        check('INPUT_EXCEEDED_BOUND', inputMs <= definition.readinessBudgetMs + 1500);
        const ready = returned?.readiness;
        if (waitMs === 0 || scenario.expected === 'settling') {
          check('UNSTABLE_INPUT_FALSE_READY', ready?.status === 'settling' && ready.reason === 'deadline' && response.result?.observationWait?.ready === false);
          check('UNSTABLE_INPUT_FALSE_VERIFIED', response.result?.execution?.verification === 'unverified' && response.result?.action?.textVerified === false);
          if (waitMs === 0) {
            check('ZERO_WAIT_RESAMPLED', ready?.samples === 1);
            check('ZERO_WAIT_BLOCKED', inputMs <= 1500 && ready?.waitedMs <= 400);
          } else {
            check('PERMANENT_REFRESH_NOT_EXERCISED', returnedOracle.refreshCount >= 20 && returnedOracle.sideEffectReady === false);
            check('SETTLING_RETURNED_EARLY', ready?.waitedMs >= definition.readinessBudgetMs - 400);
          }
        } else {
          check('INPUT_SIDE_EFFECT_NOT_READY', ready?.status === 'ready' && ready.reason === 'interaction_stable' && ready.samples >= 2 && response.result?.observationWait?.ready === true);
          check('INPUT_VALUE_NOT_VERIFIED', response.result?.execution?.verification === 'verified' && response.result?.action?.textVerified === true);
          check('INPUT_RETURNED_BEFORE_SIDE_EFFECT', returnedOracle.sideEffectReady === true && returnedOracle.effectAfterInputMs >= scenario.sideEffectDelayMs && inputMs >= scenario.sideEffectDelayMs);
          if (scenario.kind === 'enabled') {
            check('ENABLED_STATE_MISSING_FROM_RESPONSE', node(returned, 'input_settling_save')?.enabled === true && node(returned, 'input_settling_undo')?.enabled === true);
            check('ENABLED_ORACLE_MISMATCH', returnedOracle.saveEnabled === true && returnedOracle.undoEnabled === true);
          } else {
            check('RESULT_TEXT_MISSING_FROM_RESPONSE', node(returned, 'input_settling_result')?.text === '合成结果已加载');
            const beforeHeight = height(node(initial, 'input_settling_result')), afterHeight = height(node(returned, 'input_settling_result'));
            check('RESULT_GEOMETRY_MISSING_FROM_RESPONSE', beforeHeight > 0 && afterHeight > beforeHeight);
            check('GEOMETRY_ORACLE_MISMATCH', returnedOracle.resultTextChanged === true && returnedOracle.resultGeometryChanged === true);
          }
        }
        if (waitMs !== 0) {
          // Deliberate model-thinking delay, not a guess that a UI transition
          // completed. The input response already had to contain the final UI.
          const selected = target(returned, 'input_settling_search');
          if (scenario.expected === 'ready') {
            stage = 'retain_input_snapshot';
            const thinkingStarted = performance.now();
            await pause(definition.thinkingMs);
            thoughtMs = Math.round(performance.now() - thinkingStarted);
          }
          stage = 'single_retained_snapshot_target';
          targetCalls++;
          const targetStarted = performance.now();
          followup = await client.call('act_and_observe', { action: 'tap_element', arguments: selected, waitMs: definition.waitMs });
          targetMs = Math.round(performance.now() - targetStarted);
          actual = await oracle();
          if (scenario.expected === 'ready') {
            check('RETAINED_TARGET_REJECTED', followup.ok === true && followup.result?.action?.accepted === true && followup.result?.execution?.dispatch === 'sent');
            check('RETAINED_TARGET_NOT_COMPLETED', actual.targetClicks === 1 && actual.clickCount === 1 && actual.completed === true && actual.lastTarget === 'input_search');
            check('THINKING_DELAY_NOT_EXERCISED', thoughtMs >= definition.thinkingMs && actual.targetAfterInputMs >= definition.thinkingMs);
          } else {
            check('SETTLING_TARGET_NOT_REFUSED', followup.ok === false && followup.error?.details?.dispatchState === 'not_sent' && ['STALE_SNAPSHOT', 'TARGET_CHANGED', 'UI_NOT_READY'].includes(followup.error?.code));
            check('SETTLING_TARGET_EXECUTED', actual.targetClicks === 0 && actual.clickCount === 0 && actual.completed === false);
          }
        } else actual = returnedOracle;
        stage = 'independent_verification';
        check('WRONG_ACTION', actual.wrongClicks === 0);
        check('DUPLICATE_INPUT', actual.expectedInputCount === 1);
        check('SUPPLEMENTARY_UI_READ', uiReads === 1);
        check('ACTION_REPLAY_OR_MISSING_ACTION', inputCalls === 1 && targetCalls === (waitMs === 0 ? 0 : 1));
      } catch (failure) { error = safeCode(failure?.message) ?? 'INPUT_SETTLING_EVALUATION_FAILED'; }
      finally {
        if (!actual) { try { actual = await oracle(); } catch { /* Keep original failure; no raw UI/command output. */ } }
        await client?.close();
      }
      const report = { entry, scene, waitMs, status: !error && !checks.length ? 'passed' : 'failed', stage,
        modelCalls: 0, inputCalls, targetCalls, uiReads, mutationReplays: 0, fixturePrepareMs,
        inputMs, targetMs, thoughtMs, durationMs: Math.round(performance.now() - started),
        readiness: readiness(returned?.readiness), inputExecution: execution(response), targetExecution: execution(followup),
        oracleEffectReadyAfterReturn: returnedOracle?.sideEffectReady === true,
        effectAfterInputMs: count(returnedOracle?.effectAfterInputMs), refreshCountAtReturn: count(returnedOracle?.refreshCount),
        expectedInputCount: count(actual?.expectedInputCount), targetClicks: count(actual?.targetClicks),
        clickCount: count(actual?.clickCount), wrongClicks: count(actual?.wrongClicks), businessCompleted: actual?.completed === true,
        checks, ...(error ? { fixtureError: error } : {}),
      };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    const report = { schemaVersion: 1, suite: 'input-side-effect-settling', modelCalls: 0, cases: reports.length,
      passed: reports.filter(item => item.status === 'passed').length, failed: reports.filter(item => item.status === 'failed').length, reports };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reports: undefined }));
    if (report.failed) process.exitCode = 1;
    return report;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'INPUT_SETTLING_EVALUATION_FAILED'); process.exitCode = 1; });
}
