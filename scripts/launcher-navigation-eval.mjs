#!/usr/bin/env node
// Actual Android fixture + production bridge. UI/model text stays in memory only.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Adb } from '../server/dist/adb.js';
import { Bridge } from '../server/dist/bridge.js';
import { createPhoneClient } from '../server/dist/client-tools.js';
import { runAgent } from '../server/dist/runtime/index.js';
import { fullObservation } from '../server/dist/runtime/context.js';
import { acquireDeviceLease } from './testbed-batch.mjs';
import { until, observation } from './native-executor-eval.mjs';
import { trackOperation, drainOperations } from './testbed-runner.mjs';

const exec = promisify(execFile);
const pkg = 'dev.tappilot.testbed';
const cases = ['native_launcher_visible', 'native_launcher_paged', 'native_launcher_followup'];
const knownTools = new Set(['get_device_info', 'get_current_app', 'get_ui_tree', 'find_element', 'observe_target',
  'wait_for_ui_change', 'take_screenshot', 'act_and_observe', 'navigate_until']);
const actions = new Set(['tap_element', 'click_element', 'swipe', 'scroll', 'tap_visual', 'swipe_visual']);
const diagnosticActions = new Set([...actions, 'input_text', 'press_key', 'open_settings']);
const fail = code => { throw new Error(code); };
export const launcherErrorCode = value => typeof value === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(value)
  ? value : 'LAUNCHER_EVAL_FAILED';

export function allowedLauncherCall(name, args) {
  return knownTools.has(name) && (name !== 'act_and_observe' || actions.has(args?.action));
}

/** The fixture is an Activity: advertise only actions its execution sandbox permits. */
export function launcherModelTools(tools) {
  return tools.filter(tool => knownTools.has(tool.name)).map(tool => {
    if (tool.name !== 'act_and_observe') return tool;
    const copy = structuredClone(tool);
    copy.inputSchema.properties.action.enum = copy.inputSchema.properties.action.enum.filter(action => actions.has(action));
    copy.inputSchema.oneOf = copy.inputSchema.oneOf.filter(variant => actions.has(variant.properties.action.const));
    return copy;
  });
}

export function parseLauncherArguments(argv, savedModel = false) {
  const args = { timeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--use-saved-model') args.saved = true;
    else if (['--serial', '--case', '--output', '--timeout-ms'].includes(argv[index]) && argv[index + 1]) {
      args[argv[index].slice(2).replace('timeout-ms', 'timeoutMs')] = argv[++index];
    } else fail('INVALID_ARGUMENT');
  }
  args.timeoutMs = Number(args.timeoutMs);
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  if (!cases.includes(args.case) || !Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 180_000 ||
      savedModel !== (args.saved === true)) fail('INVALID_ARGUMENT');
  return args;
}

export async function createLauncherSession(args) {
  if (!/^emulator-\d+$/.test(args.serial ?? '') || !cases.includes(args.case)) fail('ISOLATED_EMULATOR_REQUIRED');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], {
    timeout: 20_000, maxBuffer: 1024 * 1024,
  })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const runId = randomUUID();
  const lease = await acquireDeviceLease({ serial: args.serial, runId });
  let client;
  const inspect = async () => {
    let state;
    try { state = JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json')); }
    catch { return undefined; }
    return state.schemaVersion === 1 && state.runId === runId && state.scene === args.case ? state : undefined;
  };
  try {
    // Reset only the synthetic app on an explicitly selected emulator; never inject UI input with ADB.
    await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', args.case, '--es', 'runId', runId);
    await until(async () => { const state = await inspect(); return state && state.completed === false &&
      state.clickCount === 0 && state.wrongClicks === 0 && state.gestureCount === 0; });
    const access = new Adb({ executable: adbPath, serial: args.serial, allowEmulator: true });
    await access.select();
    client = createPhoneClient(new Bridge(access), access);
    await until(async () => (await client.execute('get_current_app', {}, AbortSignal.timeout(5000)))?.result?.packageName === pkg);
  } catch (error) {
    try { await client?.close(); } finally { await lease.release(); }
    throw error;
  }
  return { serial: args.serial, scene: args.case, client, inspect,
    async close() { try { await client.close(); } finally { await lease.release(); } } };
}

function nativeTree(response) {
  if (response?.ok !== true) fail(launcherErrorCode(response?.error?.code));
  const tree = observation(response);
  if (!tree || tree.packageName !== pkg || tree.executor !== 'node-v1' || !Array.isArray(tree.nodes)) fail('NATIVE_FIXTURE_UI_REQUIRED');
  return tree;
}

function secondIcon(tree) {
  const candidates = tree.nodes.filter(node => node.visible !== false && node.enabled !== false && node.password !== true &&
    node.text === '微信' && /分身/.test(node.contentDescription ?? ''));
  if (candidates.length > 1) fail('FIXTURE_TARGET_AMBIGUOUS');
  return candidates[0];
}

function leftSwipe(tree) {
  const roots = tree.nodes.filter(node => node.parentId == null && Array.isArray(node.bounds) && node.bounds.length === 4 &&
    node.bounds.every(Number.isFinite) && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1]);
  if (roots.length !== 1) fail('OBSERVED_ROOT_BOUNDS_REQUIRED');
  const [left, top, right, bottom] = roots[0].bounds;
  return { snapshotId: tree.snapshotId, startX: Math.round(left + (right - left) * .8), startY: Math.round((top + bottom) / 2),
    endX: Math.round(left + (right - left) * .2), endY: Math.round((top + bottom) / 2), durationMs: 350 };
}

function stepEvidence(index, name, args, response, elapsedMs) {
  const tree = observation(response);
  const reason = response?.error?.details?.reason;
  return { index, tool: knownTools.has(name) ? name : 'unknown',
    ...(diagnosticActions.has(args?.action) ? { action: args.action } : {}),
    ...(args?.action === 'press_key' && ['home', 'back', 'recents', 'notifications', 'quick_settings'].includes(args.arguments?.key)
      ? { key: args.arguments.key } : {}), ok: response?.ok === true,
    durationMs: Math.max(0, Math.round(elapsedMs)),
    ...(response?.ok === false ? { errorCode: launcherErrorCode(response?.error?.code) } : {}),
    ...(typeof reason === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(reason) ? { reason } : {}),
    ...(typeof response?.result?.action?.accepted === 'boolean' ? { accepted: response.result.action.accepted } : {}),
    ...(['ready', 'settling'].includes(tree?.readiness?.status) ? { readiness: tree.readiness.status } : {}),
    ...(tree?.packageName === pkg && Array.isArray(tree.nodes) ? {
      launcherTitleObserved: tree.nodes.some(node => node.text === '桌面'),
      firstPageMarkerObserved: tree.nodes.some(node => /^第 1 页，共 [12] 页$/.test(node.contentDescription ?? '')),
      cloneDestinationObserved: tree.nodes.some(node => node.text === '微信 · 分身'),
      noticeDetailsObserved: tree.nodes.some(node => node.text === '活动时间：15:30'),
    } : {}),
    observationReturned: Boolean(tree) };
}

// Fixed synthetic predicates only: never serialize node text, IDs, geometry or model messages.
function launcherUiEvidence(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const description = node => node?.desc ?? node?.contentDescription ?? '';
  const candidates = nodes.filter(node => node?.text === '微信' && typeof description(node) === 'string' && description(node).includes('分身'));
  const byId = new Map(nodes.map(node => [node?.nodeId, node]));
  let secondIconHasClickableAncestor = false;
  if (candidates.length === 1) {
    const seen = new Set();
    let current = candidates[0];
    while (current && !seen.has(current.nodeId) && seen.size <= nodes.length) {
      seen.add(current.nodeId);
      if (current.visible === false || current.enabled === false || current.password === true) break;
      if (current.clickable === true) { secondIconHasClickableAncestor = true; break; }
      current = byId.get(current.parentId);
    }
  }
  return { currentUiFound: Array.isArray(tree?.nodes), secondIconPresent: candidates.length > 0, secondIconHasClickableAncestor,
    page1: nodes.some(node => ['1 / 1', '1 / 2'].includes(node?.text) || /^第 1 页，共 [12] 页$/.test(description(node))),
    page2: nodes.some(node => node?.text === '2 / 2' || description(node) === '第 2 页，共 2 页'),
    cloneDestination: nodes.some(node => node?.text === '微信 · 分身'),
    noticeDetails: nodes.some(node => node?.text === '活动时间：15:30') };
}

function modelRequestEvidence(init, requestOrdinal, priorTree) {
  let tree, parsed = false;
  try {
    const body = JSON.parse(init.body);
    if (Array.isArray(body.messages)) {
      parsed = true;
      for (const message of [...body.messages].reverse()) {
        if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
        try { tree = fullObservation(JSON.parse(message.content)); } catch { /* Non-JSON tool text is not a UI observation. */ }
        if (tree) break;
      }
    }
  } catch { /* Record absence only; do not alter the production model request. */ }
  return { requestOrdinal, parsed, ...launcherUiEvidence(tree),
    snapshotMatchesLastObserved: typeof tree?.snapshotId === 'string' && tree.snapshotId === priorTree?.snapshotId };
}

function requestedSwipeDirection(args) {
  if (!['swipe', 'swipe_visual'].includes(args?.action)) return undefined;
  const point = args.arguments;
  if (![point?.startX, point?.startY, point?.endX, point?.endY].every(Number.isFinite)) return undefined;
  const dx = point.endX - point.startX, dy = point.endY - point.startY;
  if (dx === 0 && dy === 0) return 'stationary';
  if (Math.abs(dx) === Math.abs(dy)) return 'diagonal';
  return Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'down' : 'up';
}

function oracleEvidence(state, scene) {
  const expectedGestures = scene === 'native_launcher_paged' ? 1 : 0;
  const followup = scene === 'native_launcher_followup';
  const expectedClicks = followup ? 2 : 1;
  const expectedPage = followup ? 'notice_detail' : 'destination_second';
  const valid = state && ['clickCount', 'wrongClicks', 'gestureCount', 'wrongGestures', 'cancelledGestures', 'swipeCount']
    .every(key => Number.isSafeInteger(state[key]) && state[key] >= 0);
  if (!valid) return { available: false, verified: false };
  const knownTarget = state.lastTarget === (followup ? 'launcher_notice' : 'launcher_second');
  return { available: true, correctDestination: state.page === expectedPage, completed: state.completed === true,
    knownTarget,
    clickCount: state.clickCount, wrongClicks: state.wrongClicks, gestureCount: state.gestureCount,
    wrongGestures: state.wrongGestures, cancelledGestures: state.cancelledGestures, swipeCount: state.swipeCount,
    expectedGestures, expectedClicks,
    verified: knownTarget && state.page === expectedPage && state.completed === true && state.clickCount === expectedClicks && state.wrongClicks === 0 &&
      state.gestureCount === expectedGestures && state.swipeCount === expectedGestures && state.wrongGestures === 0 && state.cancelledGestures === 0 };
}

/** Evaluate observed behavior without feeding expected route or private oracle back to the model. */
export function launcherBehaviorEvidence({ steps, scene, mode, result }) {
  const followup = scene === 'native_launcher_followup';
  const goalIndex = steps.findIndex(step => step.ok === true && (followup ? step.noticeDetailsObserved : step.cloneDestinationObserved));
  const swipeRequestsWhileTargetVisible = steps.filter(step =>
    ['swipe', 'swipe_visual', 'scroll'].includes(step.action) && step.prior?.secondIconPresent === true).length;
  const toolCallsAfterGoal = goalIndex < 0 ? 0 : steps.length - goalIndex - 1;
  // runAgent makes one final continuity read after the model finishes. It is not
  // a model decision; unlike an extra model read, it adds no provider round trip.
  const hostCompletionReadsAfterGoal = toolCallsAfterGoal > 0 && mode === 'model' &&
    result?.metrics?.completionReads === 1 && steps.at(-1)?.tool === 'get_ui_tree' ? 1 : 0;
  const modelToolCallsAfterGoal = toolCallsAfterGoal - hostCompletionReadsAfterGoal;
  // Only this fixed synthetic detail is checked, in memory; the answer never enters reports.
  const requiredDetailReported = !followup || mode !== 'model' || /(?:15[:：]30|下午\s*(?:3|三)\s*(?:点|時|时)\s*(?:30|三十|半))/.test(result?.answer ?? '');
  const modelCompleted = mode !== 'model' || result?.status === 'completed';
  return { goalObserved: goalIndex >= 0, swipeRequestsWhileTargetVisible, toolCallsAfterGoal,
    hostCompletionReadsAfterGoal, modelToolCallsAfterGoal, requiredDetailReported, modelCompleted,
    verified: goalIndex >= 0 && swipeRequestsWhileTargetVisible === 0 && modelToolCallsAfterGoal === 0 && requiredDetailReported && modelCompleted };
}

/** Both modes use the same real Android executor; only the decision maker changes. */
export async function runLauncherEvaluation({ session, model, modelFetch, timeoutMs = 120_000, signal, onProgress }) {
  const mode = model ? 'model' : 'executor';
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const running = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
  const active = new Set(), steps = [], requestEvidence = [];
  let errorCode, result, modelRequests = 0, priorTree;
  const call = (name, args, callSignal = running) => trackOperation(active, async () => {
    const begin = performance.now();
    const prior = launcherUiEvidence(priorTree);
    const swipeDirection = requestedSwipeDirection(args);
    const requestedSnapshotMatchesPrior = typeof args?.arguments?.snapshotId === 'string'
      ? args.arguments.snapshotId === priorTree?.snapshotId : undefined;
    // The fixture is an Activity, not the actual emulator launcher. Leaving it invalidates isolation.
    const allowed = allowedLauncherCall(name, args);
    const response = allowed ? await session.client.execute(name, args, callSignal) :
      { ok: false, error: { code: 'FIXTURE_ACTION_NOT_ALLOWED', message: 'Only operations inside the current test screen are allowed.', retryable: false } };
    const row = { ...stepEvidence(steps.length, name, args, response, performance.now() - begin), requestOrdinal: modelRequests,
      ...(name === 'act_and_observe' ? { prior, ...(swipeDirection ? { swipeDirection } : {}),
        ...(requestedSnapshotMatchesPrior !== undefined ? { requestedSnapshotMatchesPrior } : {}) } : {}) };
    steps.push(row); onProgress?.(row);
    const observed = fullObservation(response);
    if (observed) priorTree = observed;
    if (observation(response)?.packageName && observation(response).packageName !== pkg) fail('FIXTURE_LEFT');
    return response;
  });
  try {
    if (mode === 'model') {
      // Tasks state user goals only; no fixture route, expected UI, coordinate or required step count.
      const task = session.scene === 'native_launcher_followup'
        ? '在当前测试界面中打开第二个微信入口，再查看通知详情，告诉我活动时间。这是模拟入口，不要求启动真实微信。'
        : '在当前测试界面中打开第二个微信入口，确认进入对应页面后结束。这是模拟入口，不要求启动真实微信。';
      result = await runAgent({ task, model,
        modelFetch: (url, init) => {
          modelRequests++;
          requestEvidence.push(modelRequestEvidence(init, modelRequests, priorTree));
          return modelFetch(url, init);
        },
        tools: launcherModelTools(session.client.tools), execute: call, signal: running, maxTurns: 10 });
      if (result.status !== 'completed') errorCode = launcherErrorCode(result.error?.split(':', 1)[0]);
    } else {
      let tree = nativeTree(await call('get_ui_tree', {}));
      const pageCount = session.scene === 'native_launcher_paged' ? 2 : 1;
      if (!tree.nodes.some(node => node.text === '桌面') ||
          !tree.nodes.some(node => node.contentDescription === `第 1 页，共 ${pageCount} 页`)) fail('FIXTURE_START_PAGE_NOT_OBSERVED');
      let icon = secondIcon(tree);
      if (!icon) {
        tree = nativeTree(await call('act_and_observe', { action: 'swipe', arguments: leftSwipe(tree), waitMs: 350 }));
        icon = secondIcon(tree);
      }
      if (!icon) fail('TARGET_NOT_OBSERVED');
      const tapped = await call('act_and_observe', { action: 'tap_element', arguments: {
        snapshotId: tree.snapshotId, nodeId: icon.nodeId,
      }, waitMs: 350 });
      tree = nativeTree(tapped);
      if (tapped.result?.action?.accepted !== true) fail('TAP_NOT_ACCEPTED');
      if (session.scene === 'native_launcher_followup') {
        const notices = tree.nodes.filter(node => node.text === '通知详情' && node.visible !== false && node.enabled !== false);
        if (notices.length !== 1) fail('FIXTURE_TARGET_AMBIGUOUS');
        const detail = await call('act_and_observe', { action: 'tap_element', arguments: {
          snapshotId: tree.snapshotId, nodeId: notices[0].nodeId,
        }, waitMs: 350 });
        nativeTree(detail);
        if (detail.result?.action?.accepted !== true) fail('TAP_NOT_ACCEPTED');
      }
    }
  } catch (error) { errorCode = launcherErrorCode(error?.code ?? error?.message); }
  if (deadline.aborted) errorCode = 'CASE_TIMEOUT';
  else if (signal?.aborted) errorCode = 'CANCELLED';
  const drained = await drainOperations(active, 15_000);
  if (!drained) errorCode = 'CASE_CLEANUP_PENDING';
  const oracle = oracleEvidence(drained ? await session.inspect() : undefined, session.scene);
  const behavior = launcherBehaviorEvidence({ steps, scene: session.scene, mode, result });
  const metrics = {};
  for (const key of ['totalMs', 'modelMs', 'toolMs', 'modelRequests', 'toolCalls', 'hostReads', 'completionReads', 'preflightReads', 'modelRequestBytes', 'modelUiBytes', 'rawUiBytes']) {
    if (Number.isFinite(result?.metrics?.[key]) && result.metrics[key] >= 0) metrics[key] = result.metrics[key];
  }
  return { schemaVersion: 1, suite: 'android-launcher-navigation-v1', toolContract: 'fixture-contained-actions-v1', mode, scene: session.scene,
    passed: !errorCode && oracle.verified && behavior.verified, elapsedMs: Math.round(performance.now() - started), modelRequests,
    ...(errorCode ? { errorCode } : {}), metrics, steps, requestEvidence, oracle, behavior };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseLauncherArguments(argv);
  const session = await createLauncherSession(args);
  let report;
  try { report = await runLauncherEvaluation({ session, timeoutMs: args.timeoutMs, onProgress: step => console.log(JSON.stringify(step)) }); }
  finally { await session.close(); }
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(launcherErrorCode(error?.code ?? error?.message)); process.exitCode = 1; });
}
