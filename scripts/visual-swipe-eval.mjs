#!/usr/bin/env node
// Isolated synthetic fixture only. No model or user data; no images, UI or points saved.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Adb } from '../server/dist/adb.js';
import { Bridge } from '../server/dist/bridge.js';
import { ApprovalQueue } from '../server/dist/approvals.js';
import { ToolController } from '../server/dist/tools.js';
import { createPhoneClient } from '../server/dist/client-tools.js';
import { PhoneScreenshotSchema } from '../server/dist/screenshot.js';
import { acquireDeviceLease } from './testbed-batch.mjs';
import { until } from './native-executor-eval.mjs';

const exec = promisify(execFile);
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : 'VISUAL_SWIPE_EVAL_FAILED';
const pkg = 'dev.tappilot.testbed';
const scene = 'visual_swipe_chain';
const targetId = `${pkg}:id/visual_action_native_target`;

function imageFromTarget(response, entry) {
  const metadata = response.body?.result?.visualObservation;
  if (!metadata) fail(safeCode(response.body?.result?.visualObservationError?.code ?? 'TARGET_IMAGE_MISSING'));
  const image = entry === 'desktop' ? metadata.image : response.content?.find(item => item.type === 'image');
  const { image: _image, ...clean } = metadata;
  const parsed = PhoneScreenshotSchema.safeParse({ ...clean, data: image?.data });
  if (!parsed.success || parsed.data.packageName !== pkg || parsed.data.source !== 'window' ||
      parsed.data.observationOnly !== false || parsed.data.actionContract !== 'visual-tap-v1' || parsed.data.expiresInMs !== 60_000 ||
      !parsed.data.supportedActions?.includes('swipe_visual') || !parsed.data.supportedActions.includes('tap_visual')) fail('VISUAL_SWIPE_CAPABILITY_MISSING');
  if (entry === 'mcp' && (response.content.filter(item => item.type === 'image').length !== 1 || JSON.stringify(response.body).includes(image.data) ||
      JSON.stringify(response.content.filter(item => item.type === 'text')).includes(image.data))) fail('IMAGE_DUPLICATED_IN_TEXT');
  return { captureId: parsed.data.captureId, width: parsed.data.width, height: parsed.data.height };
}

function fixtureSwipe(capture, baseline) {
  const window = baseline.visualWindowBounds, canvas = baseline.visualCanvasBounds;
  const rect = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1];
  if (![window, canvas].every(rect) || canvas[0] < window[0] || canvas[1] < window[1] || canvas[2] > window[2] || canvas[3] > window[3] ||
      Math.abs((window[2] - window[0]) / (window[3] - window[1]) - capture.width / capture.height) > .01) fail('SYNTHETIC_WINDOW_GEOMETRY_INVALID');
  // Known test-only Canvas region. Real callers must locate a visible region in their image.
  const x = fraction => Math.floor((canvas[0] + (canvas[2] - canvas[0]) * fraction - window[0]) * capture.width / (window[2] - window[0]));
  const y = Math.floor(((canvas[1] + canvas[3]) / 2 - window[1]) * capture.height / (window[3] - window[1]));
  return { captureId: capture.captureId, startX: x(.78), startY: y, endX: x(.22), endY: y,
    durationMs: 450, targetDescription: 'Browse the synthetic cards to view details' };
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (['--serial', '--entry', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  if (args.entry && !['desktop', 'mcp'].includes(args.entry)) fail('INVALID_ENTRY');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const sdk = Number(await adb('shell', 'getprop', 'ro.build.version.sdk'));
  if (!Number.isInteger(sdk) || sdk < 34) fail('WINDOW_SCREENSHOT_EVAL_REQUIRES_API_34');
  const lease = await acquireDeviceLease({ serial: args.serial, runId: randomUUID() });
  const reports = [];
  try {
    for (const entry of args.entry ? [args.entry] : ['desktop', 'mcp']) {
      const runId = randomUUID(), started = performance.now();
      let client, errorCode, captureCalls = 0, mutationCalls = 0, targetQueries = 0;
      let passed = false, usableTreeWithMissingTarget = false, swipeCapability = false, nativeUiInAction = false, nativeTargetWithoutImage = false, replayRejected = false;
      let swipeCount, wrongGestures, cancelledGestures, finalClickCount, finalWrongClicks;
      const oracle = async () => {
        try { return JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json')); } catch { return undefined; }
      };
      try {
        await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '17');
        await until(async () => { const state = await oracle(); return state?.runId === runId && state.scene === scene && state.page === 'visual_swipe_ready'; });
        const baseline = await oracle();
        if (baseline.swipeCount !== 0 || baseline.wrongGestures !== 0 || baseline.cancelledGestures !== 0 || baseline.clickCount !== 0 || baseline.wrongClicks !== 0 || baseline.completed !== false) fail('BASELINE_NOT_EMPTY');
        const access = new Adb({ executable: adbPath, serial: args.serial, allowEmulator: true });
        await access.select();
        const transport = new Bridge(access);
        const bridge = { close: () => transport.close(), call: (name, ...rest) => {
          if (name === 'take_screenshot') captureCalls++;
          if (name === 'act_and_observe') mutationCalls++;
          return transport.call(name, ...rest);
        } };
        const controller = entry === 'mcp' ? new ToolController(bridge, access, new ApprovalQueue(), 'trusted') : undefined;
        const desktop = entry === 'desktop' ? createPhoneClient(bridge, access) : undefined;
        client = {
          call: async (name, input) => {
            if (name === 'observe_target') targetQueries++;
            if (desktop) return { body: await desktop.execute(name, input, AbortSignal.timeout(15_000)) };
            const result = await controller.invoke(name, input);
            return { body: result.structuredContent, content: result.content };
          },
          close: () => desktop ? desktop.close() : controller.close(),
        };
        await until(async () => (await client.call('get_current_app', {})).body?.result?.packageName === pkg);
        // Only a startup/rate boundary; never used to repair the measured action's observation.
        await new Promise(resolve => setTimeout(resolve, 1100));
        const query = { selector: { resourceId: targetId }, operation: 'tap', allowScreenshot: true };
        const first = await client.call('observe_target', query);
        if (first.body?.ok !== true) fail(safeCode(first.body?.error?.code));
        const before = first.body.result;
        usableTreeWithMissingTarget = before.observation?.packageName === pkg && before.observation.quality?.status === 'usable' &&
          before.target?.status === 'missing' && before.target.operation === 'tap' && before.target.nodeIds?.length === 0 &&
          before.observation.nodes?.some(node => node.resourceId === `${pkg}:id/visual_action_native_result`) === true;
        if (!usableTreeWithMissingTarget) fail('MISSING_TARGET_NOT_DISTINGUISHED_FROM_USABLE_TREE');
        const capture = imageFromTarget(first, entry);
        swipeCapability = true;
        if (captureCalls !== 1 || mutationCalls !== 0) fail('INITIAL_TARGET_OBSERVATION_MUTATED_OR_RECAPTURED');
        const input = fixtureSwipe(capture, baseline);
        const swipe = () => entry === 'desktop'
          ? client.call('act_and_observe', { action: 'swipe_visual', arguments: input, waitMs: 350 })
          : client.call('swipe_visual', input);
        const actionResponse = await swipe();
        if (actionResponse.body?.ok !== true) fail(safeCode(actionResponse.body?.error?.code));
        const result = actionResponse.body.result;
        const action = entry === 'desktop' ? result?.action : result;
        if (action?.accepted !== true || action.action !== 'swipe_visual' || action.executor !== 'visual-tap-v1' || action.dispatchState !== 'sent') fail('SWIPE_NOT_ACCEPTED');
        if (result.observationError) fail(safeCode(result.observationError.code));
        nativeUiInAction = result.observation?.packageName === pkg && result.observation.quality?.status === 'usable' &&
          result.observation.nodes?.some(node => node.resourceId === targetId && node.clickable === true && node.enabled === true) === true;
        if (!nativeUiInAction || result.visualObservation || result.visualObservationError || actionResponse.content?.some(item => item.type === 'image')) fail('NATIVE_TARGET_NOT_RETURNED_BY_SWIPE');
        const after = await oracle();
        if (after?.runId !== runId || after.page !== 'visual_swipe_native' || after.completed !== true || after.swipeCount !== 1 ||
            after.wrongGestures !== 0 || after.cancelledGestures !== 0 || after.clickCount !== 0 || after.wrongClicks !== 0) fail('SWIPE_ORACLE_MISMATCH');
        // Capability reuse is an explicit negative test, never a retry strategy.
        const replay = await swipe();
        replayRejected = replay.body?.ok === false && replay.body.error?.code === 'VISUAL_REFERENCE_INVALID' && mutationCalls === 1;
        if (!replayRejected) fail('USED_CAPTURE_REPLAY_NOT_REFUSED');
        const next = await client.call('observe_target', query);
        if (next.body?.ok !== true) fail(safeCode(next.body?.error?.code));
        const native = next.body.result;
        const ids = native.target?.nodeIds;
        nativeTargetWithoutImage = native.target?.status === 'native' && native.target.operation === 'tap' && ids?.length === 1 &&
          native.observation?.nodes?.some(node => node.nodeId === ids[0] && node.resourceId === targetId && node.clickable === true) === true &&
          !native.visualObservation && !native.visualObservationError && !next.content?.some(item => item.type === 'image') && captureCalls === 1;
        if (!nativeTargetWithoutImage) fail('NATIVE_TARGET_DID_NOT_SKIP_SCREENSHOT');
        const final = await oracle();
        if (final?.runId !== runId || final.swipeCount !== 1 || final.wrongGestures !== 0 || final.cancelledGestures !== 0 || final.clickCount !== 0 || final.wrongClicks !== 0 || final.completed !== true) fail('POST_QUERY_OR_REPLAY_CHANGED_BUSINESS_STATE');
        if (mutationCalls !== 1 || targetQueries !== 2) fail('UNEXPECTED_ACTION_OR_TARGET_QUERY');
        passed = true;
      } catch (error) { errorCode = safeCode(error.message); }
      finally {
        const final = await oracle();
        if (final?.runId === runId) {
          if (Number.isSafeInteger(final.swipeCount)) swipeCount = final.swipeCount;
          if (Number.isSafeInteger(final.wrongGestures)) wrongGestures = final.wrongGestures;
          if (Number.isSafeInteger(final.cancelledGestures)) cancelledGestures = final.cancelledGestures;
          if (Number.isSafeInteger(final.clickCount)) finalClickCount = final.clickCount;
          if (Number.isSafeInteger(final.wrongClicks)) finalWrongClicks = final.wrongClicks;
        }
        await client?.close();
      }
      const report = { entry, scene, passed, usableTreeWithMissingTarget, swipeCapability, nativeUiInAction, nativeTargetWithoutImage, replayRejected,
        captureCalls, mutationCalls, targetQueries, swipeCount, wrongGestures, cancelledGestures, finalClickCount, finalWrongClicks,
        elapsedMs: Math.round(performance.now() - started), modelCalls: 0, ...(errorCode ? { errorCode } : {}) };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
  } finally { await lease.release(); }
  const report = { cases: reports.length, passed: reports.filter(item => item.passed).length, failed: reports.filter(item => !item.passed).length, reports };
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ cases: report.cases, passed: report.passed, failed: report.failed }));
  if (report.failed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error.message)); process.exitCode = 1; });
}
