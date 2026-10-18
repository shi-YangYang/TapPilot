#!/usr/bin/env node
// A later ordinary read must notice async same-window change after an action has
// already returned ready. Oracle polling observes setup only; it never drives UI.
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
const readiness = value => value ? {
  status: choice(value.status, ['ready', 'settling']), reason: choice(value.reason, ['interaction_stable', 'known_window', 'deadline']),
  samples: count(value.samples), waitedMs: count(value.waitedMs),
} : null;
const visible = (tree, id, predicate = () => true) => (tree?.nodes ?? []).some(node => node.visible !== false &&
  [node.resourceId, node.rid].some(value => typeof value === 'string' &&
    (value.endsWith(`:id/${id}`) || value.endsWith(`/id/${id}`) || value === `id/${id}`)) && predicate(node));

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
    console.log('node scripts/late-transition-readiness-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes late_multistage_editor,late_never_ready] [--output /tmp/late-transition-readiness.json]');
    console.log('One initial read and one real tap must first return a ready unchanged page. Independent oracle then proves delayed transition started but is not ready; one later get_ui_tree must return the final editor or bounded settling. No mutation replay or supplementary recovery read.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry))) fail('INVALID_ENTRY');
  const definition = JSON.parse(await readFile(path.join(root, 'android/testbed/late-transition-readiness-scenarios.json'), 'utf8'));
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
      let client, initial, afterAction, actionResponse, returned, actionOracle, triggerOracle, actual, error;
      let stage = 'connect', actionMs = 0, readMs = 0, actionCalls = 0, uiReads = 0;
      const oracle = async () => {
        const value = JSON.parse(await adb('exec-out', 'run-as', definition.package, 'cat', definition.oraclePath));
        if (value.schemaVersion !== 1 || value.runId !== runId || value.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
        return value;
      };
      try {
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        if ((await client.call('get_device_info', {})).ok !== true) fail('RECEIVER_NOT_CONNECTED');
        stage = 'launch';
        await adb('shell', 'am', 'start', '-S', '-n', definition.activity, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '29');
        const foregroundDeadline = Date.now() + 5000;
        let foreground = false;
        do {
          const current = await client.call('get_current_app', {});
          if (current.ok === true && current.result?.packageName === definition.package) { foreground = true; break; }
          if (current.ok !== true && !['NO_ACTIVE_WINDOW', 'STALE_SNAPSHOT', 'PROTECTED_APP'].includes(current.error?.code)) fail('FIXTURE_FOREGROUND_FAILED');
          await pause(30);
        } while (Date.now() < foregroundDeadline);
        if (!foreground) fail('FIXTURE_NOT_FOREGROUND');
        const before = await oracle();
        if (before.transitionScheduled !== false || before.transitionStarted !== false || before.completed !== false || before.clickCount !== 0) fail('SETUP_ALREADY_ACTED');
        stage = 'establish_initial_ready';
        uiReads++;
        const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        if (read.ok !== true) fail(safeCode(read.error?.code) ?? 'INITIAL_READ_FAILED');
        initial = observation(read);
        if (initial?.packageName !== definition.package || initial.readiness?.status !== 'ready' || !Array.isArray(initial.nodes)) fail('INITIAL_WINDOW_NOT_READY');
        if (initial.observationCapabilities?.windowReadiness !== true) fail('READINESS_CAPABILITY_MISSING');
        stage = 'single_schedule_action';
        actionCalls++;
        const actionStarted = performance.now();
        actionResponse = await client.call('act_and_observe', { action: 'tap_element', arguments: target(initial, 'action_readiness_start'), waitMs: definition.waitMs });
        actionMs = Math.round(performance.now() - actionStarted);
        afterAction = observation(actionResponse);
        actionOracle = await oracle();
        if (actionResponse.ok !== true || actionResponse.result?.action?.accepted !== true || actionResponse.result?.execution?.dispatch !== 'sent') fail('SCHEDULE_ACTION_NOT_ACCEPTED');
        if (afterAction?.readiness?.status !== 'ready' || afterAction.readiness.reason !== 'interaction_stable' ||
          afterAction.readiness.samples < 2 || actionResponse.result?.observationWait?.ready !== true) fail('SCHEDULE_ACTION_NOT_READY');
        if (actionOracle.transitionScheduled !== true || actionOracle.transitionStarted !== false || actionOracle.completed !== false) fail('SETUP_MISSED_STABLE_OLD_PAGE');
        if (!visible(afterAction, 'action_readiness_start') || visible(afterAction, 'action_readiness_editor') ||
          actionResponse.result?.execution?.effect !== 'unchanged') fail('SCHEDULE_ACTION_CHANGED_UI');
        stage = 'await_independent_transition_start';
        const transitionDeadline = Date.now() + 6000;
        do {
          triggerOracle = await oracle();
          if (triggerOracle.transitionStarted === true) break;
          if (Date.now() >= transitionDeadline) fail('TRANSITION_DID_NOT_START');
          // Poll a debug oracle predicate, never sleep for an assumed UI duration.
          await pause(30);
        } while (true);
        if (triggerOracle.transitionReady !== false || triggerOracle.editorMounted !== false) fail('SETUP_MISSED_TRANSITION');
        stage = 'single_later_ui_read';
        uiReads++;
        const readStarted = performance.now();
        const response = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        readMs = Math.round(performance.now() - readStarted);
        if (response.ok !== true) fail(safeCode(response.error?.code) ?? 'LATE_READ_FAILED');
        returned = observation(response);
        // No more phone reads or actions. The exact returned sample must prove
        // readiness; a later oracle cannot repair an early model-facing frame.
        stage = 'independent_verification';
        actual = await oracle();
        check('READ_OBSERVATION_MISSING', returned?.packageName === definition.package && Array.isArray(returned?.nodes));
        check('WINDOW_CHANGED', Number.isInteger(initial.windowId) && afterAction?.windowId === initial.windowId && returned?.windowId === initial.windowId);
        check('DUPLICATE_OR_MISSING_ACTION', actionCalls === 1 && actual.clickCount === 1 && actual.lastTarget === 'late_transition_start');
        check('WRONG_ACTION', actual.wrongClicks === 0);
        check('SUPPLEMENTARY_UI_READ', uiReads === 2);
        check('TRANSITION_DELAY_NOT_EXERCISED', actual.transitionDelayMs >= definition.transitionDelayMs);
        check('INTERMEDIATE_FRAME_NOT_OBSERVED', actual.intermediateSamples > triggerOracle.intermediateSamples);
        check('TRANSITION_NOT_EXERCISED', actual.phaseCount >= scenario.minimumPhaseCount);
        check('WRONG_READINESS_STATUS', returned?.readiness?.status === scenario.expected);
        check('KNOWN_WINDOW_BYPASSED_RESAMPLING', returned?.readiness?.reason === (scenario.expected === 'ready' ? 'interaction_stable' : 'deadline') && returned.readiness.samples >= 2);
        check('READINESS_EXCEEDED_BOUND', returned?.readiness?.waitedMs <= definition.readinessBudgetMs + 600 && readMs <= definition.readinessBudgetMs + 1500);
        if (scenario.expected === 'ready') {
          check('ORACLE_NOT_READY', actual.transitionReady === true && actual.editorMounted === true && actual.completed === true && actual.readyAfterTransitionMs >= 600);
          check('EDITOR_MISSING_FROM_RESPONSE', visible(returned, 'action_readiness_editor', node => node.editable === true));
          check('INTERMEDIATE_UI_RETURNED', !visible(returned, 'action_readiness_intermediate') && !visible(returned, 'action_readiness_start'));
          check('TREE_NOT_USABLE', returned?.quality?.status === 'usable');
        } else {
          check('PERMANENT_CHANGE_FALSE_READY', actual.transitionReady === false && actual.editorMounted === false && actual.completed === false);
          check('PERMANENT_CHANGE_NOT_EXERCISED', actual.refreshCount >= 20);
          check('DEADLINE_RETURNED_EARLY', returned?.readiness?.waitedMs >= definition.readinessBudgetMs - 400);
        }
      } catch (failure) { error = safeCode(failure?.message) ?? 'LATE_READINESS_EVALUATION_FAILED'; }
      finally {
        if (!actual) { try { actual = await oracle(); } catch { /* Preserve the failure without raw output. */ } }
        await client?.close();
      }
      const report = { entry, scene, status: !error && !checks.length ? 'passed' : 'failed', stage,
        modelCalls: 0, actionCalls, uiReads, measuredLaterReads: Math.max(0, uiReads - 1), mutationReplays: 0,
        actionMs, readMs, durationMs: Math.round(performance.now() - started), transitionClock: definition.transitionClock,
        sameWindow: initial?.windowId != null && afterAction?.windowId === initial.windowId && returned?.windowId === initial.windowId,
        initialReadiness: readiness(initial?.readiness), actionReadiness: readiness(afterAction?.readiness), readiness: readiness(returned?.readiness),
        oldPageReadyBeforeTransition: actionOracle?.transitionScheduled === true && actionOracle.transitionStarted === false && afterAction?.readiness?.status === 'ready',
        laterReadStartedDuringTransition: triggerOracle?.transitionStarted === true && triggerOracle.transitionReady === false,
        nodeCount: count(returned?.nodes?.length), quality: choice(returned?.quality?.status, ['usable', 'limited', 'unavailable']),
        clickCount: count(actual?.clickCount), wrongClicks: count(actual?.wrongClicks),
        phaseCount: count(actual?.phaseCount), refreshCount: count(actual?.refreshCount), intermediateSamples: count(actual?.intermediateSamples),
        transitionDelayMs: count(actual?.transitionDelayMs), readyAfterTransitionMs: count(actual?.readyAfterTransitionMs),
        oracleReady: actual?.transitionReady === true, oracleCompleted: actual?.completed === true, checks,
        ...(error ? { errorCode: error } : {}),
      };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    const report = { schemaVersion: 1, suite: 'late-same-window-readiness', modelCalls: 0, cases: reports.length,
      passed: reports.filter(item => item.status === 'passed').length, failed: reports.filter(item => item.status === 'failed').length, reports };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reports: undefined }));
    if (report.failed) process.exitCode = 1;
    return report;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'LATE_READINESS_EVALUATION_FAILED'); process.exitCode = 1; });
}
