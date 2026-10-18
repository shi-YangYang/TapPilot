#!/usr/bin/env node
// Same-window post-action observation. No model, waitFor selector, supplementary UI read or replay.
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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value) ? value : undefined;
const count = value => Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
const choice = (value, values) => values.includes(value) ? value : null;
const resource = (node, id) => [node.resourceId, node.rid].some(value => typeof value === 'string' &&
  (value.endsWith(`:id/${id}`) || value.endsWith(`/id/${id}`) || value === `id/${id}`));

function argumentsOf(argv) {
  const args = { entries: 'desktop,mcp' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') args.help = true;
    else if (['--serial', '--entries', '--scenes', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/action-readiness-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes action_multistage_editor,action_noop] [--output /tmp/action-readiness.json]');
    console.log('One initial get_ui_tree establishes known-window state. One act_and_observe(waitMs=350) must return the final UI without a selector or supplementary read. Requires current testbed and receiver APKs.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry))) fail('INVALID_ENTRY');
  const definition = JSON.parse(await readFile(path.join(root, 'android/testbed/action-readiness-scenarios.json'), 'utf8'));
  const scenes = args.scenes?.split(',') ?? definition.scenarios.map(scene => scene.id);
  if (!scenes.length || new Set(scenes).size !== scenes.length || scenes.some(id => !definition.scenarios.some(scene => scene.id === id))) fail('UNKNOWN_FIXTURE');
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
      let client, before, actual, initial, returned, response, error;
      let stage = 'connect', actionMs = 0, actionCalls = 0, uiReads = 0;
      const oracle = async () => {
        const value = JSON.parse(await adb('exec-out', 'run-as', definition.package, 'cat', definition.oraclePath));
        if (value.schemaVersion !== 1 || value.runId !== runId || value.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
        return value;
      };
      try {
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        if ((await client.call('get_device_info', {})).ok !== true) fail('RECEIVER_NOT_CONNECTED');
        stage = 'launch';
        await adb('shell', 'am', 'start', '-S', '-n', definition.activity, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '23');
        const foregroundDeadline = Date.now() + 5000;
        let foreground = false;
        do {
          const current = await client.call('get_current_app', {});
          if (current.ok === true && current.result?.packageName === definition.package) { foreground = true; break; }
          if (current.ok !== true && !['NO_ACTIVE_WINDOW', 'STALE_SNAPSHOT', 'PROTECTED_APP'].includes(current.error?.code)) fail('FIXTURE_FOREGROUND_FAILED');
          await pause(30);
        } while (Date.now() < foregroundDeadline);
        if (!foreground) fail('FIXTURE_NOT_FOREGROUND');
        before = await oracle();
        if (before.transitionStarted !== false || before.completed !== false || before.clickCount !== 0) fail('SETUP_ALREADY_ACTED');
        stage = 'establish_known_window';
        uiReads++;
        const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        if (read.ok !== true) fail(safeCode(read.error?.code) ?? 'INITIAL_READ_FAILED');
        initial = observation(read);
        if (initial?.packageName !== definition.package || initial.readiness?.status !== 'ready' || !Array.isArray(initial.nodes)) fail('INITIAL_WINDOW_NOT_READY');
        if (initial.observationCapabilities?.windowReadiness !== true) fail('READINESS_CAPABILITY_MISSING');
        const chosen = target(initial, 'action_readiness_start');
        stage = 'single_action';
        actionCalls++;
        const actionStarted = performance.now();
        response = await client.call('act_and_observe', { action: 'tap_element', arguments: chosen, waitMs: definition.waitMs });
        actionMs = Math.round(performance.now() - actionStarted);
        returned = observation(response);
        // From this point onward there are no phone reads/waits/actions. A late
        // final control must be present in THIS response, not repaired by polling.
        stage = 'independent_verification';
        actual = await oracle();
        check('ACTION_NOT_ACCEPTED', response.ok === true && response.result?.action?.accepted === true && response.result?.execution?.dispatch === 'sent');
        check('ACTION_OBSERVATION_MISSING', returned?.packageName === definition.package && Array.isArray(returned?.nodes));
        check('WINDOW_CHANGED', Number.isInteger(initial.windowId) && returned?.windowId === initial.windowId);
        check('DUPLICATE_OR_MISSING_ACTION', actionCalls === 1 && actual.clickCount === 1 && actual.lastTarget === 'action_readiness_start');
        check('WRONG_ACTION', actual.wrongClicks === 0);
        check('TRANSITION_NOT_STARTED', actual.transitionStarted === true && before.transitionStarted === false);
        check('SUPPLEMENTARY_UI_READ', uiReads === 1);
        check('ACTION_RETURNED_EARLY', actionMs >= scenario.minimumActionMs);
        check('ACTION_EXCEEDED_BOUND', actionMs <= (scenario.maximumActionMs ?? definition.readinessBudgetMs + 1500));
        const readiness = returned?.readiness;
        check('WRONG_READINESS_STATUS', readiness?.status === scenario.expected);
        check('WRONG_READINESS_REASON', readiness?.reason === (scenario.expected === 'ready' ? 'interaction_stable' : 'deadline'));
        check('ACTION_NOT_RESAMPLED', Number.isInteger(readiness?.samples) && readiness.samples >= 2);
        check('READINESS_EXCEEDED_BOUND', Number.isInteger(readiness?.waitedMs) && readiness.waitedMs <= definition.readinessBudgetMs + 600);
        check('WRONG_OBSERVATION_WAIT', response.result?.observationWait?.ready === (scenario.expected === 'ready'));
        const nodes = returned?.nodes ?? [];
        const visible = (id, predicate = () => true) => nodes.some(node => resource(node, id) && node.visible !== false && predicate(node));
        if (scenario.expected === 'ready') {
          check('ORACLE_NOT_READY', actual.transitionReady === true && actual.completed === true);
          check('TREE_NOT_USABLE', returned?.quality?.status === 'usable');
          if (scenario.kind === 'noop') {
            check('NOOP_UI_CHANGED', visible('action_readiness_start') && !visible('action_readiness_editor') && !visible('action_readiness_list') && actual.phaseCount === 0);
            check('NOOP_WAIT_TOO_LONG', readiness?.waitedMs <= 1200);
            check('NOOP_FALSE_EFFECT', response.result?.execution?.effect === 'unchanged');
          } else {
            check('TRANSITION_NOT_OBSERVED', actual.intermediateSamples >= 1 && actual.phaseCount >= 5);
            check('FINAL_CONTROL_NOT_MOUNTED', actual.finalControlMounted === true && actual.readyAfterActionMs >= 600);
            check('INTERMEDIATE_UI_RETURNED', !visible('action_readiness_intermediate') && !visible('action_readiness_start'));
            if (scenario.kind === 'editor') check('EDITOR_MISSING_FROM_RESPONSE', visible('action_readiness_editor', node => node.editable === true) && actual.editorMounted === true);
            else {
              check('SCROLL_STATE_MISSING_FROM_RESPONSE', visible('action_readiness_list', node => node.scrollable === true) && actual.listScrollable === true);
              check('NON_SCROLLABLE_PHASE_NOT_OBSERVED', actual.preLoadScrollSamples >= 1);
            }
            if (scenario.kind === 'refreshing_collection') check('COLLECTION_NOT_REFRESHING', actual.refreshCount >= 3);
          }
        } else {
          check('PERMANENT_CHANGE_FALSE_READY', actual.transitionReady === false && actual.completed === false && actual.finalControlMounted === false);
          check('PERMANENT_CHANGE_NOT_EXERCISED', actual.refreshCount >= 20 && actual.intermediateSamples >= 2);
          check('DEADLINE_RETURNED_EARLY', readiness?.waitedMs >= definition.readinessBudgetMs - 400);
        }
      } catch (failure) { error = safeCode(failure?.message) ?? 'ACTION_READINESS_EVALUATION_FAILED'; }
      finally {
        if (!actual) { try { actual = await oracle(); } catch { /* Preserve setup/action failure without raw output. */ } }
        await client?.close();
      }
      const report = { entry, scene, status: !error && checks.length === 0 ? 'passed' : 'failed', stage,
        modelCalls: 0, actionCalls, uiReads, supplementaryUiReads: Math.max(0, uiReads - 1), mutationReplays: 0,
        actionMs, durationMs: Math.round(performance.now() - started), transitionClock: definition.transitionClock,
        sameWindow: initial?.windowId != null && returned?.windowId === initial.windowId,
        observationReturned: returned?.packageName === definition.package,
        readiness: returned?.readiness ? {
          status: choice(returned.readiness.status, ['ready', 'settling']),
          reason: choice(returned.readiness.reason, ['interaction_stable', 'known_window', 'deadline']),
          samples: count(returned.readiness.samples), waitedMs: count(returned.readiness.waitedMs),
        } : null,
        quality: choice(returned?.quality?.status, ['usable', 'limited', 'unavailable']), nodeCount: count(returned?.nodes?.length),
        effect: choice(response?.result?.execution?.effect, ['changed', 'unchanged', 'unknown']),
        clickCount: count(actual?.clickCount), wrongClicks: count(actual?.wrongClicks),
        oracleReady: actual?.transitionReady === true, oracleCompleted: actual?.completed === true,
        intermediateSamples: count(actual?.intermediateSamples), preLoadScrollSamples: count(actual?.preLoadScrollSamples),
        phaseCount: count(actual?.phaseCount), refreshCount: count(actual?.refreshCount),
        readyAfterActionMs: count(actual?.readyAfterActionMs), checks,
        ...(error ? { errorCode: error } : {}),
        ...(safeCode(response?.error?.code) ? { actionError: response.error.code } : {}),
        ...(safeCode(response?.error?.details?.reason) ? { actionReason: response.error.details.reason } : {}),
      };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    const report = { schemaVersion: 1, suite: 'same-window-action-readiness', modelCalls: 0, cases: reports.length,
      passed: reports.filter(item => item.status === 'passed').length, failed: reports.filter(item => item.status === 'failed').length, reports };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reports: undefined }));
    if (report.failed) process.exitCode = 1;
    return report;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'ACTION_READINESS_EVALUATION_FAILED'); process.exitCode = 1; });
}
