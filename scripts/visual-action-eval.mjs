#!/usr/bin/env node
// Isolated synthetic Canvas/composite button only. Coordinates belong to these fixtures,
// not a targeting strategy for real apps. No model, pixels or UI values are saved.
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
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : 'VISUAL_ACTION_EVAL_FAILED';
const pkg = 'dev.tappilot.testbed';
const scene = 'visual_action_chain';

function requireCapture(response, entry, followup = false) {
  if (response.body?.ok !== true) fail(safeCode(response.body?.error?.code));
  const metadata = followup ? response.body.result?.visualObservation : response.body.result;
  if (!metadata) fail(safeCode(response.body.result?.visualObservationError?.code ?? 'VISUAL_IMAGE_MISSING'));
  const image = entry === 'desktop' ? metadata.image : response.content?.find(item => item.type === 'image');
  const { image: _image, ...clean } = metadata;
  const parsed = PhoneScreenshotSchema.safeParse({ ...clean, data: image?.data });
  if (!parsed.success || parsed.data.packageName !== pkg || parsed.data.source !== 'window' ||
      parsed.data.observationOnly !== false || parsed.data.actionContract !== 'visual-tap-v1' ||
      parsed.data.expiresInMs !== 60_000 || 'snapshotId' in metadata || 'nodes' in metadata) fail('INVALID_VISUAL_CAPTURE_CONTRACT');
  if (entry === 'mcp' && (response.content.filter(item => item.type === 'image').length !== 1 ||
      JSON.stringify(response.body).includes(image.data) ||
      JSON.stringify(response.content.filter(item => item.type === 'text')).includes(image.data))) fail('IMAGE_DUPLICATED_IN_TEXT');
  // Deliberately retain no image bytes after validation; only the ephemeral capability
  // and dimensions are needed to exercise the fixed synthetic button.
  return { captureId: parsed.data.captureId, width: parsed.data.width, height: parsed.data.height };
}

function requireAccepted(response, entry) {
  if (response.body?.ok !== true) fail(safeCode(response.body?.error?.code));
  const result = response.body.result;
  const action = entry === 'desktop' ? result?.action : result;
  if (action?.accepted !== true || action.executor !== 'visual-tap-v1' || action.action !== 'tap_visual' ||
      action.dispatchState !== 'sent') fail('VISUAL_ACTION_NOT_ACCEPTED');
  if (result?.observationError) fail(safeCode(result.observationError.code));
  return result;
}

async function sensitiveCase({ entry, position, adb, adbPath, serial }) {
  const scene = 'visual_action_sensitive';
  const runId = randomUUID();
  const started = performance.now();
  let client, errorCode, captureCalls = 0, mutationCalls = 0, treeReads = 0;
  let passed = false, phoneRefused = false, finalClickCount, finalWrongClicks;
  const oracle = async () => {
    try { return JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json')); } catch { return undefined; }
  };
  try {
    await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '17');
    await until(async () => { const value = await oracle(); return value?.runId === runId && value.scene === scene && value.page === 'visual_sensitive_ready'; });
    const baseline = await oracle();
    if (baseline?.clickCount !== 0 || baseline.wrongClicks !== 0 || baseline.completed !== false) fail('BASELINE_NOT_EMPTY');
    const access = new Adb({ executable: adbPath, serial, allowEmulator: true });
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
        if (desktop) return { body: await desktop.execute(name, input, AbortSignal.timeout(15_000)) };
        const result = await controller.invoke(name, input);
        return { body: result.structuredContent, content: result.content };
      },
      close: () => desktop ? desktop.close() : controller.close(),
    };
    await until(async () => (await client.call('get_current_app', {})).body?.result?.packageName === pkg);
    const initial = (await client.call('get_ui_tree', {})).body;
    if (initial?.ok !== true || initial.result?.packageName !== pkg || initial.result.quality?.status !== 'usable') fail('SENSITIVE_FIXTURE_NOT_READABLE');
    const targets = initial.result.nodes.filter(node => node.resourceId === `${pkg}:id/visual_action_native_target`);
    const labels = initial.result.nodes.filter(node => node.resourceId === `${pkg}:id/visual_action_native_result`);
    if (targets.length !== 1 || labels.length !== 1 || targets[0].className !== 'android.widget.FrameLayout' ||
        targets[0].clickable !== true || targets[0].text || targets[0].contentDescription ||
        labels[0].clickable === true || labels[0].text !== '付款' || labels[0].parentId !== targets[0].nodeId) fail('COMPOSITE_SENSITIVE_FIXTURE_INVALID');
    await new Promise(resolve => setTimeout(resolve, 1100));
    const capture = requireCapture(await client.call('take_screenshot', {}), entry);
    const window = baseline.visualWindowBounds, target = baseline.visualTargetBounds, label = baseline.visualLabelBounds;
    const rect = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1];
    const contains = (bounds, x, y) => x >= bounds[0] && x < bounds[2] && y >= bounds[1] && y < bounds[3];
    if (![window, target, label].every(rect) || Math.abs((window[2] - window[0]) / (window[3] - window[1]) - capture.width / capture.height) > .01) fail('SYNTHETIC_WINDOW_GEOMETRY_INVALID');
    const sx = position === 'label_center' ? (label[0] + label[2]) / 2 : (target[0] + label[0]) / 2;
    const sy = (label[1] + label[3]) / 2;
    if (!contains(window, sx, sy) || !contains(target, sx, sy) || contains(label, sx, sy) !== (position === 'label_center')) fail('SYNTHETIC_POINT_NOT_IN_REQUESTED_REGION');
    // Synthetic geometry, not arbitrary device coordinates: use the exact returned JPEG scale.
    // The harmless description must pass the host so the phone detects its sensitive descendant.
    const input = { captureId: capture.captureId,
      x: Math.floor((sx - window[0]) * capture.width / (window[2] - window[0])),
      y: Math.floor((sy - window[1]) * capture.height / (window[3] - window[1])),
      targetDescription: 'Open synthetic details' };
    const response = entry === 'desktop'
      ? await client.call('act_and_observe', { action: 'tap_visual', arguments: input, waitMs: 350 })
      : await client.call('tap_visual', input);
    phoneRefused = response.body?.ok === false && response.body.error?.code === 'VISUAL_TARGET_UNSAFE' && mutationCalls === 1;
    if (!phoneRefused || response.body?.result || response.content?.some(item => item.type === 'image')) fail('PHONE_SENSITIVE_TARGET_NOT_REFUSED');
    const final = await oracle();
    finalClickCount = final?.clickCount;
    finalWrongClicks = final?.wrongClicks;
    if (final?.runId !== runId || final.page !== 'visual_sensitive_ready' || final.completed !== false || finalClickCount !== 0 || finalWrongClicks !== 0) fail('SENSITIVE_TOUCH_REACHED_APP');
    if (captureCalls !== 1 || treeReads !== 1) fail('UNEXPECTED_CAPTURE_ACTION_OR_READ');
    passed = true;
  } catch (error) { errorCode = safeCode(error.message); }
  finally {
    const final = await oracle();
    if (final?.runId === runId) {
      if (Number.isSafeInteger(final.clickCount)) finalClickCount = final.clickCount;
      if (Number.isSafeInteger(final.wrongClicks)) finalWrongClicks = final.wrongClicks;
    }
    await client?.close();
  }
  return { entry, scene, position, passed, phoneRefused, captureCalls, mutationCalls, treeReads,
    finalClickCount, finalWrongClicks, elapsedMs: Math.round(performance.now() - started), modelCalls: 0, ...(errorCode ? { errorCode } : {}) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (['--serial', '--entry', '--case', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  if (args.entry && !['desktop', 'mcp'].includes(args.entry)) fail('INVALID_ENTRY');
  if (args.case && !['chain', 'sensitive'].includes(args.case)) fail('INVALID_CASE');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const sdk = Number(await adb('shell', 'getprop', 'ro.build.version.sdk'));
  if (!Number.isInteger(sdk) || sdk < 34) fail('WINDOW_SCREENSHOT_EVAL_REQUIRES_API_34');
  const lease = await acquireDeviceLease({ serial: args.serial, runId: randomUUID() });
  const reports = [];
  try {
    for (const entry of args.case === 'sensitive' ? [] : args.entry ? [args.entry] : ['desktop', 'mcp']) {
      const runId = randomUUID();
      const started = performance.now();
      let client, errorCode, captureCalls = 0, mutationCalls = 0, treeReads = 0;
      let passed = false, replayRejected = false, automaticNewImage = false, nativeUiRecovered = false;
      let finalClickCount, finalWrongClicks;
      const oracle = async () => {
        try { return JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json')); } catch { return undefined; }
      };
      try {
        // ADB is used only for setup and an independent private business-state oracle.
        await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '17');
        await until(async () => { const value = await oracle(); return value?.runId === runId && value.scene === scene && value.page === 'visual_canvas_1'; });
        const baseline = await oracle();
        if (baseline?.clickCount !== 0 || baseline.wrongClicks !== 0 || baseline.completed !== false) fail('BASELINE_NOT_EMPTY');
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
            if (desktop) return { body: await desktop.execute(name, input, AbortSignal.timeout(15_000)) };
            const result = await controller.invoke(name, input);
            return { body: result.structuredContent, content: result.content };
          },
          close: () => desktop ? desktop.close() : controller.close(),
        };
        const tap = capture => {
          const input = { captureId: capture.captureId, x: Math.floor(capture.width / 2), y: Math.floor(capture.height / 2), targetDescription: 'Open the synthetic next page' };
          return entry === 'desktop'
            ? client.call('act_and_observe', { action: 'tap_visual', arguments: input, waitMs: 350 })
            : client.call('tap_visual', input);
        };
        await until(async () => (await client.call('get_current_app', {})).body?.result?.packageName === pkg);
        const initial = (await client.call('get_ui_tree', {})).body;
        if (initial?.ok !== true || initial.result?.packageName !== pkg || initial.result?.quality?.status !== 'unavailable') fail('CANVAS_NOT_INACCESSIBLE');
        // Fixture startup/rate gate only, never a compensating read after a measured action.
        await new Promise(resolve => setTimeout(resolve, 1100));
        const first = requireCapture(await client.call('take_screenshot', {}), entry);
        const firstResponse = await tap(first);
        const firstResult = requireAccepted(firstResponse, entry);
        if (firstResult.observation?.packageName !== pkg || firstResult.observation?.quality?.status !== 'unavailable') fail('FIRST_CANVAS_OBSERVATION_MISSING');
        const second = requireCapture(firstResponse, entry, true);
        automaticNewImage = second.captureId !== first.captureId && captureCalls === 2;
        if (!automaticNewImage) fail('NEW_IMAGE_NOT_RETURNED_WITH_ACTION');
        const afterFirst = await oracle();
        if (afterFirst?.runId !== runId || afterFirst.page !== 'visual_canvas_2' || afterFirst.clickCount !== 1 || afterFirst.wrongClicks !== 0 || afterFirst.completed !== false) fail('FIRST_TOUCH_ORACLE_MISMATCH');

        // An intentional invalid replay tests capability enforcement, not recovery.
        // It must not reach Android, consume the new capture, or produce a second touch.
        const replay = await tap(first);
        replayRejected = replay.body?.ok === false && replay.body.error?.code === 'VISUAL_REFERENCE_INVALID';
        const afterReplay = await oracle();
        if (!replayRejected || mutationCalls !== 1 || afterReplay?.clickCount !== 1 || afterReplay.wrongClicks !== 0) fail('OLD_CAPTURE_REPLAY_NOT_REJECTED');

        const secondResponse = await tap(second);
        const secondResult = requireAccepted(secondResponse, entry);
        nativeUiRecovered = secondResult.observation?.packageName === pkg && secondResult.observation?.quality?.status === 'usable' &&
          secondResult.observation.nodes?.some(node => node.resourceId === `${pkg}:id/visual_action_native_target` && node.clickable === true && node.enabled === true) === true;
        if (!nativeUiRecovered || secondResult.visualObservation || secondResult.visualObservationError || secondResponse.content?.some(item => item.type === 'image')) fail('NATIVE_UI_NOT_RECOVERED_IN_ACTION_RESULT');
        const final = await oracle();
        finalClickCount = final?.clickCount;
        finalWrongClicks = final?.wrongClicks;
        if (final?.runId !== runId || final.page !== 'visual_native_ready' || final.completed !== true || finalClickCount !== 2 || finalWrongClicks !== 0) fail('FINAL_BUSINESS_ORACLE_MISMATCH');
        if (captureCalls !== 2 || mutationCalls !== 2 || treeReads !== 1) fail('UNEXPECTED_CAPTURE_ACTION_OR_READ');
        passed = true;
      } catch (error) { errorCode = safeCode(error.message); }
      finally {
        const final = await oracle();
        if (final?.runId === runId) {
          if (Number.isSafeInteger(final.clickCount)) finalClickCount = final.clickCount;
          if (Number.isSafeInteger(final.wrongClicks)) finalWrongClicks = final.wrongClicks;
        }
        await client?.close();
      }
      // Fixed enums, numbers and booleans only. Never serialize captures, UI, raw errors or coordinates.
      const report = { entry, scene, passed, automaticNewImage, replayRejected, nativeUiRecovered, captureCalls, mutationCalls, treeReads,
        finalClickCount, finalWrongClicks, elapsedMs: Math.round(performance.now() - started), modelCalls: 0, ...(errorCode ? { errorCode } : {}) };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    if (args.case !== 'chain') {
      for (const entry of args.entry ? [args.entry] : ['desktop', 'mcp']) {
        for (const position of ['label_center', 'container_blank']) {
          const report = await sensitiveCase({ entry, position, adb, adbPath, serial: args.serial });
          reports.push(report);
          console.log(JSON.stringify(report));
        }
      }
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
