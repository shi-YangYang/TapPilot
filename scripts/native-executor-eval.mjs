#!/usr/bin/env node
// Real AccessibilityService / RPC regression harness. No LLM, no coordinate input, no action retries.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'dev.tappilot.testbed';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : undefined;

function argumentsOf(argv) {
  const args = { entries: 'desktop,mcp', repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') args.help = true;
    else if (['--serial', '--entries', '--scenes', '--repeat', '--output'].includes(argv[i]) && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
    else fail('INVALID_ARGUMENT');
  }
  args.repeat = Number(args.repeat);
  if (!Number.isInteger(args.repeat) || args.repeat < 1 || args.repeat > 10) fail('INVALID_ARGUMENT');
  return args;
}

export function observation(value) {
  return value?.result?.observation ?? value?.observation ?? (Array.isArray(value?.result?.nodes) ? value.result : undefined);
}

export function target(tree, id) {
  if (tree?.executor !== 'node-v1' || tree.packageName !== packageName || !Array.isArray(tree.nodes)) fail('NATIVE_EXECUTOR_UI_REQUIRED');
  const nodes = tree.nodes.filter(node => typeof node.resourceId === 'string' && node.resourceId.endsWith(`/id/${id}`) && node.visible !== false && node.enabled !== false);
  // Android resource names are package:id/name, compact projections may use id/name.
  const candidates = nodes.length ? nodes : tree.nodes.filter(node =>
    [node.resourceId, node.rid].some(value => typeof value === 'string' && (value.endsWith(`:id/${id}`) || value === `id/${id}`)) &&
    node.visible !== false && node.enabled !== false);
  if (candidates.length !== 1) fail('FIXTURE_TARGET_AMBIGUOUS');
  return { snapshotId: tree.snapshotId, nodeId: candidates[0].nodeId };
}

function stableUiSignature(tree, maskedResourceIds = []) {
  const indexes = new Map(tree.nodes.map((node, index) => [node.nodeId, index]));
  return JSON.stringify({ packageName: tree.packageName, windowId: tree.windowId, truncated: tree.truncated,
    nodes: tree.nodes.map(({ nodeId, parentId, ...evidence }) => {
      const refreshingLabel = maskedResourceIds.some(id => [evidence.resourceId, evidence.rid].some(value =>
        typeof value === 'string' && (value.endsWith(`:id/${id}`) || value === `id/${id}` || value.endsWith(`/id/${id}`))));
      return { ...evidence,
        // Only fixture-owned timer text is excluded from launch stabilization. Keep empty/non-string
        // values and all geometry, role, state and structure exact. Never mutate the action snapshot.
        ...(refreshingLabel && typeof evidence.text === 'string' && evidence.text.length ? { text: '[fixture-refresh-text]' } : {}),
        parentIndex: parentId == null ? null : indexes.get(parentId) ?? 'missing',
      };
    }),
  });
}

/** Fixture launch stabilization only. Known timer labels may refresh; never reread after the measured mutation/action. */
export async function stableSetupTree(client, first, requiredIds, maskedResourceIds = []) {
  let previous, current = first;
  const deadline = Date.now() + 6_000;
  do {
    let signature;
    try { requiredIds.forEach(id => target(current, id)); signature = stableUiSignature(current, maskedResourceIds); }
    catch { signature = undefined; }
    if (signature && signature === previous) return current;
    previous = signature;
    await pause(100);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('FIXTURE_STARTUP_NOT_STABLE');
    let timer;
    let read;
    try {
      read = await Promise.race([
        client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FIXTURE_STARTUP_NOT_STABLE')), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    current = read.ok ? observation(read) : undefined;
  } while (Date.now() < deadline);
  fail('FIXTURE_STARTUP_NOT_STABLE');
}

export async function until(probe, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value) return value;
    await pause(35);
  } while (Date.now() < deadline);
  fail('FIXTURE_CONDITION_TIMEOUT');
}

/** Both native suites use the exact desktop/MCP production controllers. */
export async function createNativeEntry(entry, { adbPath, serial }) {
  const { Adb } = await import(pathToFileURL(path.join(root, 'server/dist/adb.js')));
  const { Bridge } = await import(pathToFileURL(path.join(root, 'server/dist/bridge.js')));
  const { ToolController } = await import(pathToFileURL(path.join(root, 'server/dist/tools.js')));
  const { ApprovalQueue } = await import(pathToFileURL(path.join(root, 'server/dist/approvals.js')));
  const { createPhoneClient } = await import(pathToFileURL(path.join(root, 'server/dist/client-tools.js')));
  const access = new Adb({ executable: adbPath, serial, allowEmulator: true });
  await access.select();
  const bridge = new Bridge(access);
  if (entry === 'desktop') {
    const client = createPhoneClient(bridge, access);
    return { call: (name, input) => client.execute(name, input, AbortSignal.timeout(15_000)), close: () => client.close() };
  }
  const controller = new ToolController(bridge, access, new ApprovalQueue(), 'trusted');
  return { call: async (name, input) => {
    const response = await controller.invoke(name, input);
    return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  }, close: () => bridge.close() };
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/native-executor-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes native_refresh,native_rebind] [--repeat 2] [--output /tmp/native-executor-report.json]');
    console.log('Requires pre-authorized TapPilot and testbed debug APKs on a dedicated emulator. Does not configure permissions or use a model.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry)) || new Set(entries).size !== entries.length) fail('INVALID_ENTRY');
  const definitions = JSON.parse(await readFile(path.join(root, 'android/testbed/native-scenarios.json'), 'utf8'));
  const scenes = args.scenes?.split(',') ?? definitions.scenarios.map(scene => scene.id);
  if (scenes.some(id => !definitions.scenarios.some(scene => scene.id === id))) fail('UNKNOWN_FIXTURE');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const reports = [];
  for (const entry of entries) for (const id of scenes) for (let repetition = 1; repetition <= args.repeat; repetition++) {
    const scenario = definitions.scenarios.find(scene => scene.id === id);
    const runId = randomUUID();
    const seed = 17;
    const started = performance.now();
    let client, actionCalls = 0, result, actual, tree, ticksBefore = 0, fixtureError, armErrorCode, armErrorReason;
    const oracle = async () => {
      let value;
      try { value = JSON.parse(await adb('exec-out', 'run-as', packageName, 'cat', definitions.oraclePath)); }
      catch { return undefined; } // Atomic file replacement can briefly race the debug read.
      return value.schemaVersion === 1 && value.runId === runId && value.scene === id && value.seed === seed ? value : undefined;
    };
    try {
      // Sole ADB mutation: reset this isolated synthetic fixture. Never inject input or grant permissions.
      await adb('shell', 'am', 'start', '-S', '-n', definitions.activity, '--es', 'scene', id, '--ei', 'seed', String(seed), '--es', 'runId', runId);
      await until(async () => {
        const state = await oracle();
        return state?.page === 'native_ready' && state.completed === false && state.clickCount === 0 && state;
      });
      client = await createNativeEntry(entry, { adbPath, serial: args.serial });
      await until(async () => {
        const current = await client.call('get_current_app', {});
        return current.ok === true && current.result?.packageName === packageName;
      });
      const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
      if (!read.ok) fail('FIXTURE_READ_FAILED');
      tree = observation(read);
      const targetId = scenario.action === 'input_text' ? 'native_input' : 'native_target';
      target(tree, targetId);
      const startupRefreshLabels = {
        native_refresh: ['native_leaf'], native_form_refresh: ['native_status'], native_form_allowed: ['native_status'],
      };
      tree = await stableSetupTree(client, tree, scenario.change === 'armed' ? [targetId, 'native_arm'] : [targetId],
        startupRefreshLabels[id] ?? []);
      if (scenario.change === 'armed') {
        // Preparation must publish a ready pre-change snapshot. waitMs:0 now
        // honestly returns settling and cannot authorize the measured action.
        const arm = await client.call('act_and_observe', { action: 'tap_element', arguments: target(tree, 'native_arm'), waitMs: 350 });
        if (!arm.ok || arm.result?.action?.accepted !== true) {
          armErrorCode = safeCode(arm.error?.code);
          armErrorReason = safeCode(arm.error?.details?.reason);
          fail('FIXTURE_ARM_FAILED');
        }
        tree = observation(arm);
        if (tree?.readiness?.status !== 'ready' || arm.result?.observationWait?.ready !== true) fail('FIXTURE_ARM_NOT_READY');
        target(tree, targetId);
        // Ensure we actually captured before the page mutation, not an already changed page.
        const armed = await oracle();
        if (!armed?.armed || armed.changed) fail('FIXTURE_CHANGE_TOO_EARLY');
        await until(async () => {
          const state = await oracle();
          return state?.changed && (id !== 'native_form_recipient_silent' || state.suppressedContentEvents > 0);
        });
      } else if (scenario.change === 'continuous') {
        ticksBefore = (await oracle())?.refreshCount ?? 0;
        await until(async () => (await oracle())?.refreshCount >= ticksBefore + 4);
      }
      const actionArgs = { ...target(tree, targetId), ...(scenario.action === 'input_text' ? { text: '中文输入验证' } : {}),
        ...(scenario.allowedLabelChanges ? { allowedLabelChanges: scenario.allowedLabelChanges.map(id => target(tree, id).nodeId) } : {}) };
      actionCalls++;
      result = await client.call('act_and_observe', { action: scenario.action, arguments: actionArgs, waitMs: 0 });
      actual = await until(async () => await oracle());
    } catch (error) { fixtureError = safeCode(error.message) ?? 'NATIVE_FIXTURE_FAILED'; }
    finally { await client?.close(); }
    const successExpected = scenario.expected === 'success';
    const isInput = scenario.action === 'input_text';
    const safeRefusal = result?.ok === false && ['TARGET_CHANGED', 'STALE_SNAPSHOT', 'NODE_NOT_ACTIONABLE'].includes(result.error?.code) &&
      result.error?.details?.dispatchState === 'not_sent' &&
      scenario.reasons?.includes(result.error?.details?.reason) === true;
    const actionResult = result?.result?.action;
    const expectedAllowanceCount = scenario.allowedLabelChanges?.length ?? 0;
    const verificationValid = actionResult?.contextVerification === (expectedAllowanceCount ? 'explicit_label_changes' : 'default_context') &&
      actionResult?.allowedLabelChangesCount === expectedAllowanceCount;
    const dispatched = result?.ok === true && actionResult?.accepted === true && actionResult?.dispatchState === 'sent';
    const newObservation = observation(result);
    const observationValid = newObservation?.executor === 'node-v1' && newObservation.packageName === packageName && Array.isArray(newObservation.nodes);
    const stateValid = actual && actual.wrongClicks === 0 && (actual.wrongInputs ?? 0) === 0 && actual.clickCount === (successExpected && !isInput ? 1 : 0) &&
      actual.completed === successExpected && (successExpected ?
        isInput ? actual.receivedInput === 'expected' && actual.inputField === 'native_field' && actual.page === 'native_typed' :
          actual.lastTarget === 'native_target' && actual.page === 'native_selected' :
        actual.lastTarget === 'none' && actual.receivedInput === 'none');
    const progressValid = (scenario.change !== 'continuous' || actual?.refreshCount >= ticksBefore + 4) &&
      (id !== 'native_form_recipient_silent' || actual?.suppressedContentEvents > 0);
    const passed = !fixtureError && actionCalls === 1 && stateValid && progressValid && (successExpected ? dispatched && verificationValid && observationValid : safeRefusal);
    const report = { entry, scene: id, repetition, status: passed ? successExpected ? 'success' : 'safe_refusal' : 'failed',
      actionCalls, modelCalls: 0, clickCount: actual?.clickCount ?? null, wrongClicks: actual?.wrongClicks ?? null,
      wrongInputs: actual?.wrongInputs ?? 0,
      suppressedContentEvents: actual?.suppressedContentEvents ?? 0,
      refreshCount: actual?.refreshCount ?? null, observationReturned: observationValid,
      verificationValid,
      ...(['default_context', 'explicit_label_changes'].includes(actionResult?.contextVerification) ?
        { contextVerification: actionResult.contextVerification, allowedLabelChangesCount: actionResult.allowedLabelChangesCount } : {}),
      ...(dispatched ? { dispatchState: 'sent' } : result?.error?.details?.dispatchState === 'not_sent' ? { dispatchState: 'not_sent' } : {}),
      ...(safeCode(result?.error?.code) ? { errorCode: result.error.code } : {}),
      ...(safeCode(result?.error?.details?.reason) ? { reason: result.error.details.reason } : {}),
      ...(armErrorCode ? { armErrorCode } : {}), ...(armErrorReason ? { armErrorReason } : {}),
      ...(fixtureError ? { fixtureError } : {}), durationMs: Math.round(performance.now() - started) };
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  const summary = { schemaVersion: 1, cases: reports.length, modelCalls: 0,
    success: reports.filter(report => report.status === 'success').length,
    safeRefusal: reports.filter(report => report.status === 'safe_refusal').length,
    failed: reports.filter(report => report.status === 'failed').length, reports };
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, reports: undefined }));
  if (summary.failed) process.exitCode = 1;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error.message) ?? 'NATIVE_EXECUTOR_EVAL_FAILED'); process.exitCode = 1; });
}
