#!/usr/bin/env node
// Synthetic emulator fixtures only. No external model, recorded UI, images or real-app coordinates.
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
const pkg = 'dev.tappilot.testbed';
const scenes = ['visual_dynamic_remote', 'visual_dynamic_target', 'visual_dynamic_swipe', 'native_navigation_pages'];
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : 'DYNAMIC_NAVIGATION_EVAL_FAILED';

function captureReference(response, entry) {
  if (response.body?.ok !== true) fail(safeCode(response.body?.error?.code));
  const metadata = response.body.result;
  const image = entry === 'desktop' ? metadata?.image : response.content?.find(item => item.type === 'image');
  const { image: _image, ...clean } = metadata;
  const parsed = PhoneScreenshotSchema.safeParse({ ...clean, data: image?.data });
  if (!parsed.success || parsed.data.packageName !== pkg || parsed.data.source !== 'window' ||
      parsed.data.observationOnly !== false || parsed.data.actionContract !== 'visual-tap-v1' ||
      !parsed.data.supportedActions?.includes('swipe_visual')) fail('INVALID_VISUAL_CAPTURE_CONTRACT');
  return { captureId: parsed.data.captureId, width: parsed.data.width, height: parsed.data.height };
}

function fixturePoints(capture, baseline) {
  const window = baseline.visualWindowBounds, canvas = baseline.visualCanvasBounds, target = baseline.visualTargetBounds;
  const valid = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1];
  if (![window, canvas, target].every(valid) || Math.abs((window[2] - window[0]) / (window[3] - window[1]) - capture.width / capture.height) > .01) fail('SYNTHETIC_WINDOW_GEOMETRY_INVALID');
  const x = value => Math.floor((value - window[0]) * capture.width / (window[2] - window[0]));
  const y = value => Math.floor((value - window[1]) * capture.height / (window[3] - window[1]));
  return {
    tap: { x: x((target[0] + target[2]) / 2), y: y((target[1] + target[3]) / 2) },
    swipe: { startX: x(canvas[0] + (canvas[2] - canvas[0]) * .8), startY: y((canvas[1] + canvas[3]) / 2),
      endX: x(canvas[0] + (canvas[2] - canvas[0]) * .2), endY: y((canvas[1] + canvas[3]) / 2), durationMs: 450 },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (['--serial', '--entry', '--case', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  if (args.entry && !['desktop', 'mcp'].includes(args.entry) || args.case && !scenes.includes(args.case)) fail('INVALID_ARGUMENT');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  if (Number(await adb('shell', 'getprop', 'ro.build.version.sdk')) < 34) fail('WINDOW_SCREENSHOT_EVAL_REQUIRES_API_34');
  const lease = await acquireDeviceLease({ serial: args.serial, runId: randomUUID() });
  const reports = [];
  try {
    for (const entry of args.entry ? [args.entry] : ['desktop', 'mcp']) for (const scene of args.case ? [args.case] : scenes) {
      const runId = randomUUID(), started = performance.now();
      let client, passed = false, errorCode, captureCalls = 0, mutationCalls = 0, treeReads = 0, navigationCalls = 0;
      let targetFound = false, rejectedWithoutTouch = false, nativeUiRecovered = false, completedSteps;
      let finalClickCount, finalWrongClicks, finalGestureCount, finalWrongGestures, finalCancelledGestures;
      const oracle = async () => { try { return JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json')); } catch { return undefined; } };
      try {
        await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', scene, '--es', 'runId', runId);
        const ready = scene === 'native_navigation_pages' ? 'native_navigation_0' : 'dynamic_ready';
        await until(async () => { const state = await oracle(); return state?.runId === runId && state.scene === scene && state.page === ready; });
        const baseline = await oracle();
        if (baseline.clickCount !== 0 || baseline.wrongClicks !== 0 || baseline.gestureCount !== 0 || baseline.wrongGestures !== 0 || baseline.completed !== false) fail('BASELINE_NOT_EMPTY');
        const access = new Adb({ executable: adbPath, serial: args.serial, allowEmulator: true });
        await access.select();
        const transport = new Bridge(access);
        const bridge = { close: () => transport.close(), call: (name, ...rest) => {
          if (name === 'take_screenshot') captureCalls++;
          if (name === 'act_and_observe') mutationCalls++;
          if (name === 'get_ui_tree') treeReads++;
          return transport.call(name, ...rest);
        } };
        const controller = entry === 'mcp' ? new ToolController(bridge, access, new ApprovalQueue(), 'trusted') : undefined;
        const desktop = entry === 'desktop' ? createPhoneClient(bridge, access) : undefined;
        client = {
          call: async (name, input) => {
            if (name === 'navigate_until') navigationCalls++;
            if (desktop) return { body: await desktop.execute(name, input, AbortSignal.timeout(25_000)) };
            const result = await controller.invoke(name, input);
            return { body: result.structuredContent, content: result.content };
          },
          close: () => desktop ? desktop.close() : controller.close(),
        };
        await until(async () => (await client.call('get_current_app', {})).body?.result?.packageName === pkg);
        const initial = (await client.call('get_ui_tree', {})).body;
        if (initial?.ok !== true || initial.result?.packageName !== pkg) fail('INITIAL_OBSERVATION_MISSING');
        if (scene === 'native_navigation_pages') {
          if (initial.result.quality?.status !== 'usable') fail('NATIVE_FIXTURE_NOT_READABLE');
          const response = await client.call('navigate_until', { snapshotId: initial.result.snapshotId, mode: 'swipe', direction: 'left',
            stopWhen: { resourceId: `${pkg}:id/visual_action_native_target` }, maxSteps: 4 });
          if (response.body?.ok !== true) fail(safeCode(response.body?.error?.code));
          const result = response.body.result;
          targetFound = result.navigation?.targetFound === true && result.navigation.stopReason === 'target_found';
          completedSteps = result.navigation?.completedSteps;
          const state = await oracle();
          if (!targetFound) fail(safeCode(result.navigation?.error?.code ?? `NAVIGATION_${String(result.navigation?.stopReason).toUpperCase()}`));
          if (completedSteps !== 2 || state?.page !== 'native_navigation_2' || state.completed !== true || state.gestureCount !== 2 ||
              state.wrongGestures !== 0 || state.cancelledGestures !== 0 || state.clickCount !== 0 || state.wrongClicks !== 0) fail('NATIVE_NAVIGATION_ORACLE_MISMATCH');
          if (!result.observation?.nodes?.some(node => node.resourceId === `${pkg}:id/visual_action_native_target`) ||
              navigationCalls !== 1 || mutationCalls !== 2 || treeReads !== 2 || captureCalls !== 0) fail('NATIVE_NAVIGATION_EXTRA_ROUND_TRIPS');
        } else {
          if (initial.result.quality?.status !== 'unavailable') fail('CANVAS_NOT_INACCESSIBLE');
          // Only the startup screenshot rate boundary, never a retry after an action.
          await new Promise(resolve => setTimeout(resolve, 1100));
          const capture = captureReference(await client.call('take_screenshot', {}), entry);
          const points = fixturePoints(capture, baseline);
          // Arms synthetic pixels after observing the baseline; no phone UI is touched by ADB.
          await adb('shell', 'am', 'broadcast', '-a', 'dev.tappilot.testbed.DYNAMIC_NAVIGATION_ARM', '-p', pkg, '--es', 'runId', runId);
          await until(async () => { const state = await oracle(); return state?.runId === runId && state.armed === true && state.frame >= 3; });
          const swipe = scene === 'visual_dynamic_swipe';
          const action = swipe ? 'swipe_visual' : 'tap_visual';
          const input = { captureId: capture.captureId, ...(swipe ? points.swipe : points.tap),
            targetDescription: swipe ? 'Browse the synthetic animated cards' : 'Open the synthetic details' };
          const response = entry === 'desktop' ? await client.call('act_and_observe', { action, arguments: input, waitMs: 350 }) : await client.call(action, input);
          const state = await oracle();
          if (scene === 'visual_dynamic_target') {
            rejectedWithoutTouch = response.body?.ok === false && response.body.error?.code === 'VISUAL_SCENE_CHANGED' &&
              state?.touchDownCount === 0 && state.clickCount === 0 && state.gestureCount === 0 && state.wrongClicks === 0;
            if (!rejectedWithoutTouch || state.page !== 'dynamic_ready' || state.completed !== false) fail('CHANGED_TARGET_NOT_REFUSED_WITHOUT_TOUCH');
          } else {
            if (response.body?.ok !== true) fail(safeCode(response.body?.error?.code));
            const result = response.body.result, accepted = entry === 'desktop' ? result.action : result;
            if (accepted?.accepted !== true || accepted.action !== action || accepted.executor !== 'visual-tap-v1' || accepted.dispatchState !== 'sent') fail('VISUAL_ACTION_NOT_ACCEPTED');
            nativeUiRecovered = result.observation?.quality?.status === 'usable' && result.observation.nodes?.some(node => node.resourceId === `${pkg}:id/visual_action_native_result`) === true;
            if (!nativeUiRecovered || result.observationError || result.visualObservationError || result.visualObservation) fail('NATIVE_UI_NOT_RETURNED_WITH_ACTION');
            if (state?.page !== 'dynamic_native_done' || state.completed !== true || state.touchDownCount !== 1 ||
                state.clickCount !== (swipe ? 0 : 1) || state.gestureCount !== (swipe ? 1 : 0) || state.wrongClicks !== 0 ||
                state.wrongGestures !== 0 || state.cancelledGestures !== 0) fail('DYNAMIC_ACTION_ORACLE_MISMATCH');
          }
          if (captureCalls !== 1 || mutationCalls !== 1 || treeReads !== 1) fail('UNEXPECTED_CAPTURE_ACTION_OR_READ');
        }
        passed = true;
      } catch (error) { errorCode = safeCode(error.message); }
      finally {
        const state = await oracle();
        if (state?.runId === runId) {
          finalClickCount = state.clickCount; finalWrongClicks = state.wrongClicks;
          finalGestureCount = state.gestureCount; finalWrongGestures = state.wrongGestures; finalCancelledGestures = state.cancelledGestures;
        }
        await client?.close();
      }
      const report = { entry, scene, passed, targetFound, rejectedWithoutTouch, nativeUiRecovered, completedSteps,
        captureCalls, mutationCalls, treeReads, navigationCalls, finalClickCount, finalWrongClicks, finalGestureCount, finalWrongGestures, finalCancelledGestures,
        modelCalls: 0, elapsedMs: Math.round(performance.now() - started), ...(errorCode ? { errorCode } : {}) };
      reports.push(report); console.log(JSON.stringify(report));
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
