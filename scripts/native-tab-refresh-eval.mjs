#!/usr/bin/env node
// Exercise the production native tab guard with one retained ready observation.
// Android handler state is the independent oracle; no model, label allowance,
// supplementary UI read, coordinate injection or mutation replay is used.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeEntry, observation, target } from './native-executor-eval.mjs';
import { acquireDeviceLease } from './testbed-batch.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value) ? value : undefined;
const count = value => Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
const choice = (value, choices) => choices.includes(value) ? value : null;
const readyEvidence = value => value ? { status: choice(value.status, ['ready', 'settling']),
  reason: choice(value.reason, ['interaction_stable', 'known_window', 'deadline']), samples: count(value.samples), waitedMs: count(value.waitedMs) } : null;
const definition = {
  package: 'dev.tappilot.testbed', activity: 'dev.tappilot.testbed/.MainActivity', oraclePath: 'files/oracle.json',
  waitMs: 350, refreshDelayMs: 1400, minimumRefreshes: 3,
  scenarios: [
    { id: 'native_tab_initial_refresh', expected: 'success', nativeTabs: true, recipientChanged: false, initialRefresh: true },
    { id: 'native_tab_refresh', expected: 'success', nativeTabs: true, recipientChanged: false },
    { id: 'native_button_refresh', expected: 'refusal', nativeTabs: false, recipientChanged: false },
    { id: 'native_tab_recipient_refresh', expected: 'refusal', nativeTabs: true, recipientChanged: true },
  ],
};

function argumentsOf(argv) {
  const args = { entries: 'desktop,mcp' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') args.help = true;
    else if (['--serial', '--entries', '--scenes', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  return args;
}

function observedTarget(tree) {
  const selected = target(tree, 'native_target');
  return { ...selected, node: tree.nodes.find(node => node.nodeId === selected.nodeId) };
}

export function nativeTabContextChange(value) {
  if (!value || !choice(value.region, ['target', 'ancestor', 'target_descendant', 'peer_item', 'outside_target', 'mixed', 'unknown']) ||
    !choice(value.kind, ['content', 'state', 'structure', 'geometry', 'mixed', 'unknown']) ||
    !Number.isInteger(value.changedNodes) || value.changedNodes < 0 || value.changedNodes > 500 ||
    typeof value.targetMatched !== 'boolean' || typeof value.actionTargetMatched !== 'boolean') return null;
  return { region: value.region, kind: value.kind, changedNodes: value.changedNodes,
    targetMatched: value.targetMatched, actionTargetMatched: value.actionTargetMatched };
}

const comparisonFields = [
  ['text', 'content'], ['contentDescription', 'content'], ['className', 'structure'], ['resourceId', 'structure'],
  ['bounds', 'geometry'], ['nativeDrawingOrder', 'geometry'], ['clickable', 'state'], ['longClickable', 'state'],
  ['editable', 'state'], ['scrollable', 'state'], ['password', 'state'], ['checkable', 'state'],
  ['checked', 'state'], ['selected', 'state'], ['focused', 'state'], ['enabled', 'state'], ['visible', 'state'],
  ['contextProtected', 'state'], ['showingHintText', 'state'],
];
const knownRoles = new Map([
  ['native_list', 'tab_bar'], ['native_target', 'destination'], ['native_peer_a', 'initial_tab'],
  ['native_arm', 'prepare'], ['native_status', 'status'], ['native_recipient', 'recipient'],
  ['native_leaf', 'static_label'], ['semantic_result', 'page'],
].map(([id, role]) => [`${definition.package}:id/${id}`, role]));

function comparableValue(node, field) {
  if (['text', 'contentDescription', 'className', 'resourceId'].includes(field)) return typeof node[field] === 'string' ? node[field] : '';
  if (['clickable', 'longClickable', 'editable', 'scrollable', 'password', 'checkable', 'contextProtected'].includes(field)) return node[field] === true;
  if (['enabled', 'visible'].includes(field)) return node[field] !== false;
  if (field === 'bounds') return Array.isArray(node.bounds) && node.bounds.length === 4 && node.bounds.every(Number.isFinite) ? JSON.stringify(node.bounds) : null;
  if (field === 'nativeDrawingOrder') return Number.isInteger(node[field]) ? node[field] : null;
  return typeof node[field] === 'boolean' ? node[field] : null;
}

/** Diagnostics run only after the measured operation. No values, handles, hashes
 * or selectors leave this function; even known fixture roles are fixed enums.
 */
export function nativeTabObservationComparison(before, after) {
  const valid = tree => tree?.packageName === definition.package && Array.isArray(tree.nodes) && tree.nodes.length <= 500 &&
    tree.nodes.every(node => node && typeof node === 'object' && !Array.isArray(node) && typeof node.nodeId === 'string') &&
    new Set(tree.nodes.map(node => node.nodeId)).size === tree.nodes.length;
  if (!valid(before) || !valid(after)) return { available: false };
  const result = { available: true, beforeNodeCount: before.nodes.length, afterNodeCount: after.nodes.length,
    complete: before.truncated === false && after.truncated === false,
    sameWindow: before.windowId === after.windowId, alignment: 'unavailable', fieldChanges: [], controlChanges: [] };
  const rootSize = tree => {
    const bounds = tree.nodes.find(node => node.parentId == null)?.bounds;
    return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isSafeInteger)
      ? { width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] } : null;
  };
  result.rootSizeBefore = rootSize(before);
  result.rootSizeAfter = rootSize(after);
  const oldRoot = before.nodes.find(node => node.parentId == null)?.bounds;
  const newRoot = after.nodes.find(node => node.parentId == null)?.bounds;
  if (result.rootSizeBefore && result.rootSizeAfter) result.rootTranslation = { dx: newRoot[0] - oldRoot[0], dy: newRoot[1] - oldRoot[1] };
  const parentIndexes = tree => {
    const indexes = new Map(tree.nodes.map((node, index) => [node.nodeId, index]));
    return tree.nodes.map(node => node.parentId == null ? -1 : indexes.get(node.parentId) ?? -2);
  };
  const beforeParents = parentIndexes(before), afterParents = parentIndexes(after);
  if (before.nodes.length === after.nodes.length && !beforeParents.includes(-2) && !afterParents.includes(-2)) {
    const parentChanges = beforeParents.filter((parent, index) => parent !== afterParents[index]).length;
    if (parentChanges) result.fieldChanges.push({ field: 'parentIndex', kind: 'structure', changedNodes: parentChanges });
    else {
      result.alignment = 'ordered_paths';
      for (const [field, kind] of comparisonFields) {
        const changedNodes = before.nodes.filter((node, index) => comparableValue(node, field) !== comparableValue(after.nodes[index], field)).length;
        if (changedNodes) result.fieldChanges.push({ field, kind, changedNodes });
      }
    }
  } else if (before.nodes.length !== after.nodes.length) {
    result.fieldChanges.push({ field: 'nodeCount', kind: 'structure', changedNodes: Math.abs(before.nodes.length - after.nodes.length) });
  }
  for (const [resourceId, role] of knownRoles) {
    const previous = before.nodes.filter(node => node.resourceId === resourceId);
    const current = after.nodes.filter(node => node.resourceId === resourceId);
    const fields = previous.length > 1 || current.length > 1 ? ['ambiguous'] : previous.length !== current.length ? ['presence'] :
      previous.length === 1 ? comparisonFields.filter(([field]) => comparableValue(previous[0], field) !== comparableValue(current[0], field)).map(([field]) => field) : [];
    if (fields.length) result.controlChanges.push({ role, fields });
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/native-tab-refresh-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes native_tab_refresh,native_tab_recipient_refresh] [--output /tmp/native-tab-refresh.json]');
    console.log('Use the first ready UI snapshot for startup-refresh, or the one arm action observation for delayed-refresh. Independently observe at least 3 more refreshes, then tap once with that retained snapshot. No label allowances, extra UI reads or action replay.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry))) fail('INVALID_ENTRY');
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
      let client, initial, prepared, armOracle, preparedOracle, triggerOracle, actual, response, returned, error;
      let stage = 'connect', actionCalls = 0, measuredActionCalls = 0, uiReads = 0, armMs = 0, targetMs = 0;
      let refreshBaseline = 0;
      const expectedArmClicks = scenario.initialRefresh ? 0 : 1;
      const oracle = async () => {
        const value = JSON.parse(await adb('exec-out', 'run-as', definition.package, 'cat', definition.oraclePath));
        if (value.schemaVersion !== 1 || value.runId !== runId || value.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
        return value;
      };
      try {
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        if ((await client.call('get_device_info', {})).ok !== true) fail('RECEIVER_NOT_CONNECTED');
        stage = 'launch';
        // Only setup launches via ADB; all UI mutations use the production controller.
        await adb('shell', 'am', 'start', '-S', '-n', definition.activity, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '37');
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
        if ((!scenario.initialRefresh && (before.refreshScheduled !== false || before.refreshStarted !== false)) || before.clickCount !== 0 ||
          before.completed !== false || before.targetSelected !== false || before.nativeTabs !== scenario.nativeTabs) fail('SETUP_ALREADY_ACTED');
        if (scenario.initialRefresh && (before.refreshScheduled !== true || before.refreshStarted !== true || before.refreshCount < 1)) fail('INITIAL_REFRESH_NOT_STARTED');
        stage = 'initial_ready';
        uiReads++;
        const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        if (read.ok !== true) fail(safeCode(read.error?.code) ?? 'INITIAL_READ_FAILED');
        initial = observation(read);
        if (initial?.packageName !== definition.package || initial.readiness?.status !== 'ready' || !Array.isArray(initial.nodes)) fail('INITIAL_WINDOW_NOT_READY');
        if (scenario.initialRefresh) {
          prepared = initial;
          preparedOracle = await oracle();
          if (preparedOracle.refreshStarted !== true || preparedOracle.armClicks !== 0 ||
            !Number.isInteger(preparedOracle.refreshCount) || preparedOracle.refreshCount < 1) fail('INITIAL_REFRESH_NOT_STARTED');
          if (initial.readiness.reason !== 'interaction_stable' || initial.readiness.samples < 2) fail('INITIAL_NAVIGATION_NOT_STABLE');
          refreshBaseline = preparedOracle.refreshCount;
        } else {
          stage = 'single_arm';
          actionCalls++;
          const armStarted = performance.now();
          const arm = await client.call('act_and_observe', { action: 'tap_element', arguments: target(initial, 'native_arm'), waitMs: definition.waitMs });
          armMs = Math.round(performance.now() - armStarted);
          prepared = observation(arm);
          armOracle = await oracle();
          preparedOracle = armOracle;
          if (arm.ok !== true || arm.result?.action?.accepted !== true || arm.result?.execution?.dispatch !== 'sent') fail('ARM_NOT_ACCEPTED');
          if (prepared?.readiness?.status !== 'ready' || prepared.readiness.reason !== 'interaction_stable' ||
            prepared.readiness.samples < 2 || arm.result?.observationWait?.ready !== true) fail('ARM_NOT_READY');
          if (armOracle.refreshScheduled !== true || armOracle.refreshStarted !== false || armOracle.targetClicks !== 0 || armOracle.armClicks !== 1) fail('SETUP_MISSED_READY_PAGE');
          if (arm.result?.execution?.effect !== 'unchanged') fail('ARM_CHANGED_UI');
        }
        const selected = observedTarget(prepared);
        if (selected.node?.selected !== false) fail('INITIAL_TARGET_ALREADY_SELECTED');
        // Keep exactly this handle; oracle polling never refreshes or replaces it.
        const retainedTarget = { snapshotId: selected.snapshotId, nodeId: selected.nodeId };
        stage = 'await_independent_refresh';
        const refreshDeadline = Date.now() + 6000;
        do {
          triggerOracle = await oracle();
          if (triggerOracle.refreshStarted === true && triggerOracle.refreshCount >= refreshBaseline + definition.minimumRefreshes) break;
          if (Date.now() >= refreshDeadline) fail('REFRESH_DID_NOT_START');
          await pause(30);
        } while (true);
        if (triggerOracle.targetClicks !== 0 || triggerOracle.targetSelected !== false || triggerOracle.recipientChanged !== scenario.recipientChanged) fail('INVALID_REFRESH_PRECONDITION');
        stage = 'single_measured_target';
        actionCalls++; measuredActionCalls++;
        const targetStarted = performance.now();
        response = await client.call('act_and_observe', { action: 'tap_element', arguments: retainedTarget, waitMs: definition.waitMs });
        targetMs = Math.round(performance.now() - targetStarted);
        returned = observation(response);
        stage = 'independent_verification';
        actual = await oracle();
        check('SUPPLEMENTARY_UI_READ', uiReads === 1);
        check('ACTION_REPLAY_OR_MISSING_ACTION', actionCalls === expectedArmClicks + 1 && measuredActionCalls === 1 && actual.armClicks === expectedArmClicks);
        check('REFRESH_NOT_EXERCISED', actual.refreshCount >= refreshBaseline + definition.minimumRefreshes &&
          actual.refreshDelayMs >= (scenario.initialRefresh ? 0 : definition.refreshDelayMs));
        check('WRONG_RECIPIENT_STATE', actual.recipientChanged === scenario.recipientChanged);
        check('WRONG_ACTION', actual.wrongClicks === 0);
        check('WINDOW_CHANGED', Number.isInteger(initial.windowId) && prepared?.windowId === initial.windowId && returned?.windowId === initial.windowId);
        check('CURRENT_OBSERVATION_MISSING', returned?.packageName === definition.package && Array.isArray(returned?.nodes));
        if (scenario.expected === 'success') {
          check('TAB_ACTION_NOT_SENT', response.ok === true && response.result?.action?.accepted === true && response.result?.execution?.dispatch === 'sent');
          check('GENERIC_TAB_PROOF_MISSING', response.result?.action?.contextVerification === 'native_tab_navigation' &&
            response.result?.action?.allowedLabelChangesCount === 0 && Number.isInteger(response.result?.action?.automaticLabelChangesCount) &&
            response.result.action.automaticLabelChangesCount >= 1 && response.result.action.automaticLabelChangesCount <= 8);
          check('ACTUAL_TARGET_NOT_COMPLETED', actual.targetClicks === 1 && actual.clickCount === expectedArmClicks + 1 && actual.lastTarget === 'native_tab_destination' &&
            actual.completed === true && actual.page === 'native_tab_destination' && actual.targetSelected === true);
          check('OBSERVED_TAB_NOT_SELECTED', observedTarget(returned).node?.selected === true);
          check('CLICK_VERIFICATION_FABRICATED', response.result?.execution?.verification === 'unverified');
        } else {
          check('WRONG_REFUSAL', response.ok === false && response.error?.code === 'TARGET_CHANGED' && response.error?.details?.reason === 'PAGE_CONTEXT_CHANGED');
          check('REFUSAL_DISPATCHED', response.error?.details?.dispatchState === 'not_sent');
          check('REFUSED_TARGET_EXECUTED', actual.targetClicks === 0 && actual.clickCount === 1 && actual.lastTarget === 'native_tab_arm' &&
            actual.completed === false && actual.page === 'native_tab_initial' && actual.targetSelected === false);
        }
      } catch (failure) { error = safeCode(failure?.message) ?? 'NATIVE_TAB_EVALUATION_FAILED'; }
      finally {
        if (!actual) { try { actual = await oracle(); } catch { /* Preserve the original failure, never raw output. */ } }
        await client?.close();
      }
      const report = { entry, scene, status: !error && !checks.length ? scenario.expected === 'success' ? 'success' : 'safe_refusal' : 'failed', stage,
        modelCalls: 0, actionCalls, measuredActionCalls, uiReads, mutationReplays: 0, requestedLabelAllowanceCount: 0,
        initialRefresh: scenario.initialRefresh === true, armMs, targetMs, durationMs: Math.round(performance.now() - started),
        preparedReadiness: readyEvidence(prepared?.readiness), readiness: readyEvidence(returned?.readiness),
        preparedBeforeRefresh: armOracle?.refreshScheduled === true && armOracle.refreshStarted === false && prepared?.readiness?.status === 'ready',
        preparedWhileRefreshing: preparedOracle?.refreshStarted === true && prepared?.readiness?.status === 'ready',
        refreshBaseline: count(refreshBaseline),
        refreshesBeforeMeasuredAction: count(triggerOracle?.refreshCount), refreshCount: count(actual?.refreshCount), refreshDelayMs: count(actual?.refreshDelayMs),
        armClicks: count(actual?.armClicks), targetClicks: count(actual?.targetClicks), clickCount: count(actual?.clickCount), wrongClicks: count(actual?.wrongClicks),
        businessCompleted: actual?.completed === true, targetSelected: actual?.targetSelected === true, recipientChanged: actual?.recipientChanged === true,
        dispatch: choice(response?.result?.execution?.dispatch ?? response?.error?.details?.dispatchState, ['sent', 'not_sent', 'unknown']),
        verification: choice(response?.result?.execution?.verification, ['verified', 'unverified']),
        contextVerification: choice(response?.result?.action?.contextVerification, ['default_context', 'explicit_label_changes', 'native_tab_navigation']),
        allowedLabelChangesCount: Number.isInteger(response?.result?.action?.allowedLabelChangesCount) && response.result.action.allowedLabelChangesCount >= 0 && response.result.action.allowedLabelChangesCount <= 8
          ? response.result.action.allowedLabelChangesCount : null,
        automaticLabelChangesCount: Number.isInteger(response?.result?.action?.automaticLabelChangesCount) && response.result.action.automaticLabelChangesCount >= 0 && response.result.action.automaticLabelChangesCount <= 8
          ? response.result.action.automaticLabelChangesCount : null, checks,
        contextChange: nativeTabContextChange(response?.error?.details?.contextChange),
        observationComparison: nativeTabObservationComparison(prepared, returned),
        ...(error ? { fixtureError: error } : {}), ...(safeCode(response?.error?.code) ? { errorCode: response.error.code } : {}),
        ...(safeCode(response?.error?.details?.reason) ? { reason: response.error.details.reason } : {}),
      };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    const report = { schemaVersion: 1, suite: 'native-tab-refresh', modelCalls: 0, cases: reports.length,
      success: reports.filter(item => item.status === 'success').length, safeRefusal: reports.filter(item => item.status === 'safe_refusal').length,
      failed: reports.filter(item => item.status === 'failed').length, reports };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reports: undefined }));
    if (report.failed) process.exitCode = 1;
    return report;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'NATIVE_TAB_EVALUATION_FAILED'); process.exitCode = 1; });
}
