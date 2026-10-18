#!/usr/bin/env node
// Explicit native label allowance using one retained READY snapshot. No model,
// reread, relaxed context, mutation replay or global-ready success assumption.
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
const readyEvidence = value => value ? { status: choice(value.status, ['ready', 'settling']),
  reason: choice(value.reason, ['interaction_stable', 'known_window', 'deadline']), samples: count(value.samples), waitedMs: count(value.waitedMs) } : null;

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
    console.log('node scripts/declared-label-readiness-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes label_refresh_allowed,label_refresh_recipient] [--output /tmp/declared-label-readiness.json]');
    console.log('One arm tap returns a ready form before delayed label refresh. After 3 independently observed refreshes, one target tap uses that retained snapshot with or without its exact allowedLabelChanges. No supplementary UI reads or action replay.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry))) fail('INVALID_ENTRY');
  const definition = JSON.parse(await readFile(path.join(root, 'android/testbed/declared-label-readiness-scenarios.json'), 'utf8'));
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
      let client, initial, prepared, armOracle, triggerOracle, actual, response, returned, error;
      let stage = 'connect', actionCalls = 0, measuredActionCalls = 0, uiReads = 0, armMs = 0, targetMs = 0;
      const oracle = async () => {
        const value = JSON.parse(await adb('exec-out', 'run-as', definition.package, 'cat', definition.oraclePath));
        if (value.schemaVersion !== 1 || value.runId !== runId || value.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
        return value;
      };
      try {
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        if ((await client.call('get_device_info', {})).ok !== true) fail('RECEIVER_NOT_CONNECTED');
        stage = 'launch';
        await adb('shell', 'am', 'start', '-S', '-n', definition.activity, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '31');
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
        if (before.refreshScheduled !== false || before.refreshStarted !== false || before.clickCount !== 0 || before.completed !== false) fail('SETUP_ALREADY_ACTED');
        stage = 'initial_ready';
        uiReads++;
        const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        if (read.ok !== true) fail(safeCode(read.error?.code) ?? 'INITIAL_READ_FAILED');
        initial = observation(read);
        if (initial?.packageName !== definition.package || initial.readiness?.status !== 'ready' || !Array.isArray(initial.nodes)) fail('INITIAL_WINDOW_NOT_READY');
        stage = 'single_arm';
        actionCalls++;
        const armStarted = performance.now();
        const arm = await client.call('act_and_observe', { action: 'tap_element', arguments: target(initial, 'native_arm'), waitMs: definition.waitMs });
        armMs = Math.round(performance.now() - armStarted);
        prepared = observation(arm);
        armOracle = await oracle();
        if (arm.ok !== true || arm.result?.action?.accepted !== true || arm.result?.execution?.dispatch !== 'sent') fail('ARM_NOT_ACCEPTED');
        if (prepared?.readiness?.status !== 'ready' || prepared.readiness.reason !== 'interaction_stable' ||
          prepared.readiness.samples < 2 || arm.result?.observationWait?.ready !== true) fail('ARM_NOT_READY');
        if (armOracle.refreshScheduled !== true || armOracle.refreshStarted !== false || armOracle.targetClicks !== 0 || armOracle.armClicks !== 1) fail('SETUP_MISSED_READY_FORM');
        if (arm.result?.execution?.effect !== 'unchanged') fail('ARM_CHANGED_UI');
        const selected = target(prepared, 'native_target');
        const statusLabel = target(prepared, 'native_status');
        stage = 'await_independent_refresh';
        const refreshDeadline = Date.now() + 6000;
        do {
          triggerOracle = await oracle();
          if (triggerOracle.refreshStarted === true && triggerOracle.refreshCount >= definition.minimumRefreshes) break;
          if (Date.now() >= refreshDeadline) fail('REFRESH_DID_NOT_START');
          await pause(30);
        } while (true);
        if (triggerOracle.targetClicks !== 0 || triggerOracle.recipientChanged !== scenario.recipientChanged) fail('INVALID_REFRESH_PRECONDITION');
        stage = 'single_measured_target';
        actionCalls++; measuredActionCalls++;
        const targetStarted = performance.now();
        response = await client.call('act_and_observe', { action: 'tap_element', arguments: { ...selected,
          ...(scenario.declareStatus ? { allowedLabelChanges: [statusLabel.nodeId] } : {}) }, waitMs: definition.waitMs });
        targetMs = Math.round(performance.now() - targetStarted);
        returned = observation(response);
        stage = 'independent_verification';
        actual = await oracle();
        check('SUPPLEMENTARY_UI_READ', uiReads === 1);
        check('ACTION_REPLAY_OR_MISSING_ACTION', actionCalls === 2 && measuredActionCalls === 1 && actual.armClicks === 1);
        check('REFRESH_NOT_EXERCISED', actual.refreshCount >= definition.minimumRefreshes && actual.refreshDelayMs >= definition.refreshDelayMs);
        check('WRONG_RECIPIENT_STATE', actual.recipientChanged === scenario.recipientChanged);
        check('WRONG_ACTION', actual.wrongClicks === 0);
        check('WINDOW_CHANGED', Number.isInteger(initial.windowId) && prepared?.windowId === initial.windowId && returned?.windowId === initial.windowId);
        check('CURRENT_OBSERVATION_MISSING', returned?.packageName === definition.package && Array.isArray(returned?.nodes));
        if (scenario.expected === 'success') {
          check('DECLARED_ACTION_NOT_SENT', response.ok === true && response.result?.action?.accepted === true && response.result?.execution?.dispatch === 'sent');
          check('DECLARATION_NOT_USED', response.result?.action?.contextVerification === 'explicit_label_changes' && response.result?.action?.allowedLabelChangesCount === 1);
          check('ACTUAL_TARGET_NOT_COMPLETED', actual.targetClicks === 1 && actual.clickCount === 2 && actual.lastTarget === 'declared_label_target' && actual.completed === true);
          // Local target proof must not manufacture a global ready observation.
          check('GLOBAL_READINESS_FABRICATED', returned?.readiness?.status === 'settling' && returned.readiness.reason === 'deadline' && response.result?.observationWait?.ready === false);
          check('CLICK_VERIFICATION_FABRICATED', response.result?.execution?.verification === 'unverified');
        } else {
          check('WRONG_REFUSAL', response.ok === false && response.error?.code === scenario.errorCode && response.error?.details?.reason === scenario.reason);
          check('REFUSAL_DISPATCHED', response.error?.details?.dispatchState === 'not_sent');
          check('REFUSED_TARGET_EXECUTED', actual.targetClicks === 0 && actual.clickCount === 1 && actual.lastTarget === 'declared_label_arm' && actual.completed === false);
        }
      } catch (failure) { error = safeCode(failure?.message) ?? 'DECLARED_LABEL_EVALUATION_FAILED'; }
      finally {
        if (!actual) { try { actual = await oracle(); } catch { /* Keep original failure without raw output. */ } }
        await client?.close();
      }
      const report = { entry, scene, status: !error && !checks.length ? scenario.expected === 'success' ? 'success' : 'safe_refusal' : 'failed', stage,
        modelCalls: 0, actionCalls, measuredActionCalls, uiReads, mutationReplays: 0, declaredStatus: scenario.declareStatus,
        armMs, targetMs, durationMs: Math.round(performance.now() - started),
        preparedReadiness: readyEvidence(prepared?.readiness), readiness: readyEvidence(returned?.readiness),
        preparedBeforeRefresh: armOracle?.refreshScheduled === true && armOracle.refreshStarted === false && prepared?.readiness?.status === 'ready',
        refreshesBeforeMeasuredAction: count(triggerOracle?.refreshCount), refreshCount: count(actual?.refreshCount), refreshDelayMs: count(actual?.refreshDelayMs),
        armClicks: count(actual?.armClicks), targetClicks: count(actual?.targetClicks), clickCount: count(actual?.clickCount), wrongClicks: count(actual?.wrongClicks),
        businessCompleted: actual?.completed === true, recipientChanged: actual?.recipientChanged === true,
        dispatch: choice(response?.result?.execution?.dispatch ?? response?.error?.details?.dispatchState, ['sent', 'not_sent', 'unknown']),
        verification: choice(response?.result?.execution?.verification, ['verified', 'unverified']), checks,
        ...(error ? { fixtureError: error } : {}), ...(safeCode(response?.error?.code) ? { errorCode: response.error.code } : {}),
        ...(safeCode(response?.error?.details?.reason) ? { reason: response.error.details.reason } : {}),
      };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    const report = { schemaVersion: 1, suite: 'declared-label-readiness', modelCalls: 0, cases: reports.length,
      success: reports.filter(item => item.status === 'success').length, safeRefusal: reports.filter(item => item.status === 'safe_refusal').length,
      failed: reports.filter(item => item.status === 'failed').length, reports };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reports: undefined }));
    if (report.failed) process.exitCode = 1;
    return report;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'DECLARED_LABEL_EVALUATION_FAILED'); process.exitCode = 1; });
}
