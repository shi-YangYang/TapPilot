#!/usr/bin/env node
// Synthetic emulator only. Window metadata stays in memory; no UI, dump, pixels or points saved.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeEntry, observation, until } from './native-executor-eval.mjs';
import { acquireDeviceLease } from './testbed-batch.mjs';

const exec = promisify(execFile);
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value) ? value : 'RAW_SWIPE_WINDOW_EVAL_FAILED';
const pkg = 'dev.tappilot.testbed';
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const intersects = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// Only Android's fixed AccessibilityWindowInfo fields are read. Titles and other
// dump content are neither returned from this parser nor logged/persisted.
function windowsFromDump(value) {
  const found = new Map();
  for (const match of value.matchAll(/AccessibilityWindowInfo\[[^\r\n]*?\]/g)) {
    const line = match[0];
    const numeric = name => { const result = line.match(new RegExp(`(?:\\[|, )${name}=(-?\\d+)`)); return result ? Number(result[1]) : undefined; };
    const bounds = line.match(/bounds=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)/);
    const type = line.match(/(?:\[|, )type=(TYPE_[A-Z_]+)/)?.[1];
    const active = line.match(/(?:\[|, )active=(true|false)/)?.[1];
    const focused = line.match(/(?:\[|, )focused=(true|false)/)?.[1];
    const id = numeric('id'), layer = numeric('layer');
    if (!Number.isInteger(id) || !Number.isInteger(layer) || !bounds || !type || !active || !focused) continue;
    const result = { id, layer, type, active: active === 'true', focused: focused === 'true', bounds: bounds.slice(1).map(Number) };
    if (found.has(id) && !same(found.get(id), result)) fail('WINDOW_METADATA_CONFLICT');
    found.set(id, result);
  }
  if (!found.size) fail('WINDOW_METADATA_UNAVAILABLE');
  return [...found.values()];
}

function nativeSignature(tree) {
  if (!tree || !Array.isArray(tree.nodes)) return undefined;
  const ids = new Map(tree.nodes.map((node, index) => [node.nodeId, index]));
  return JSON.stringify({ packageName: tree.packageName, windowId: tree.windowId, truncated: tree.truncated,
    nodes: tree.nodes.map(({ nodeId, parentId, ...fields }) => ({ ...fields, parentIndex: parentId == null ? null : ids.get(parentId) ?? -1 })) });
}

function foregroundAndPanel(windows, windowId, surface) {
  const main = windows.find(window => window.id === windowId);
  if (!main || main.type !== 'TYPE_APPLICATION' || !main.active || !main.focused) fail('MAIN_WINDOW_NOT_ACTIVE_AND_FOCUSED');
  const candidates = windows.filter(window => window.id !== windowId && window.type === 'TYPE_APPLICATION' && window.layer > main.layer &&
    window.bounds[2] - window.bounds[0] < (surface[2] - surface[0]) * .4 && window.bounds[3] - window.bounds[1] < (surface[3] - surface[1]) * .15);
  if (candidates.length !== 1 || candidates[0].active || candidates[0].focused) fail('NONFOCUSABLE_PANEL_NOT_CONFIRMED');
  return { main, panel: candidates[0] };
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (['--serial', '--entry', '--case', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  if (args.entry && !['desktop', 'mcp'].includes(args.entry)) fail('INVALID_ENTRY');
  if (args.case && !['noise', 'obscured'].includes(args.case)) fail('INVALID_CASE');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const lease = await acquireDeviceLease({ serial: args.serial, runId: randomUUID() });
  const reports = [];
  try {
    for (const entry of args.entry ? [args.entry] : ['desktop', 'mcp']) for (const kind of args.case ? [args.case] : ['noise', 'obscured']) {
      const scene = `raw_swipe_window_${kind}`, runId = randomUUID(), started = performance.now();
      let client, initial, returned, response, actual, errorCode, stage = 'setup';
      let actionCalls = 0, uiReads = 0, windowSamples = 0, passed = false, serviceRevisionAdvanced = false;
      let mainWindowStable = false, panelInactive = false, panelBoundsChanged = false, pathObscured = false, nativeTreeUnchanged = false;
      const oracle = async () => {
        const state = JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json'));
        if (state.runId !== runId || state.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
        return state;
      };
      const inspectWindows = async () => { windowSamples++; return windowsFromDump(await adb('shell', 'dumpsys', 'accessibility')); };
      try {
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '17');
        await until(async () => { try { return (await oracle()).page === 'raw_swipe_window_ready'; } catch { return false; } });
        await until(async () => (await client.call('get_current_app', {})).result?.packageName === pkg);
        const baseline = await oracle();
        if (baseline.armed !== false || baseline.panelUpdates !== 0 || baseline.touchDownCount !== 0 || baseline.overlayTouches !== 0) fail('SETUP_ALREADY_ACTED');
        stage = 'initial_snapshot';
        uiReads++;
        const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        if (read.ok !== true) fail(safeCode(read.error?.code));
        initial = observation(read);
        if (initial?.packageName !== pkg || initial.executor !== 'node-v1' || initial.truncated !== false || initial.readiness?.status !== 'ready') fail('INITIAL_WINDOW_NOT_READY');
        const surfaces = initial.nodes.filter(node => node.resourceId === `${pkg}:id/raw_swipe_window_surface`);
        const surface = baseline.surfaceBounds;
        if (surfaces.length !== 1 || !same(surfaces[0].bounds, surface) || !Array.isArray(surface) || surface.length !== 4) fail('SURFACE_GEOMETRY_MISMATCH');
        const y = Math.floor((surface[1] + surface[3]) / 2);
        const startX = Math.floor(surface[0] + (surface[2] - surface[0]) * .78), endX = Math.floor(surface[0] + (surface[2] - surface[0]) * .22);
        const region = [endX - 1, y - 1, startX + 2, y + 2];
        const before = foregroundAndPanel(await inspectWindows(), initial.windowId, surface);
        if (intersects(before.panel.bounds, region)) fail('INITIAL_PANEL_ALREADY_OBSCURES_PATH');
        stage = 'arm_window_change';
        // Test setup trigger only: no UI read, new snapshot or injected input follows.
        await adb('shell', 'am', 'broadcast', '-a', `${pkg}.RAW_SWIPE_WINDOW_ARM`, '-p', pkg, '--es', 'runId', runId);
        await until(async () => (await oracle()).panelUpdates >= (kind === 'noise' ? 3 : 1));
        // Window metadata may change before Android's 80ms accessibility notification
        // arrives. Wait for the service to observe an event without replacing the
        // saved snapshot, matching the model's real decision delay.
        await until(async () => {
          const current = await client.call('get_current_app', {});
          if (current.ok !== true || current.result?.packageName !== pkg || current.result.windowId !== initial.windowId) fail('FOREGROUND_CHANGED_DURING_EVENT_WAIT');
          serviceRevisionAdvanced = current.result.revision > initial.revision;
          return serviceRevisionAdvanced;
        });
        let after;
        await until(async () => {
          after = foregroundAndPanel(await inspectWindows(), initial.windowId, surface);
          return !same(after.panel.bounds, before.panel.bounds);
        });
        mainWindowStable = before.main.id === after.main.id && same(before.main.bounds, after.main.bounds) && before.main.layer === after.main.layer && after.main.active && after.main.focused;
        panelInactive = !before.panel.active && !before.panel.focused && !after.panel.active && !after.panel.focused;
        panelBoundsChanged = before.panel.id === after.panel.id && !same(before.panel.bounds, after.panel.bounds);
        pathObscured = intersects(after.panel.bounds, region);
        if (!mainWindowStable || !panelInactive || !panelBoundsChanged || pathObscured !== (kind === 'obscured')) fail('WINDOW_CHANGE_PRECONDITION_FAILED');
        stage = 'single_original_snapshot_swipe';
        actionCalls++;
        response = await client.call('act_and_observe', { action: 'swipe', arguments: {
          snapshotId: initial.snapshotId, startX, startY: y, endX, endY: y, durationMs: 450,
        }, waitMs: 350 });
        returned = observation(response);
        actual = await oracle();
        nativeTreeUnchanged = nativeSignature(initial) === nativeSignature(returned);
        stage = 'verify';
        if (kind === 'noise') {
          if (response.ok !== true || response.result?.action?.accepted !== true || response.result.action.dispatchState !== 'sent') fail(safeCode(response.error?.code ?? 'SWIPE_NOT_ACCEPTED'));
          if (!nativeTreeUnchanged || returned.windowId !== initial.windowId) fail('FOREGROUND_TREE_CHANGED');
          if (actual.touchDownCount !== 1 || actual.gestureCount !== 1 || actual.wrongGestures !== 0 || actual.cancelledGestures !== 0 || actual.overlayTouches !== 0 || actual.completed !== true) fail('SWIPE_ORACLE_MISMATCH');
        } else {
          if (response.ok !== false || response.error?.code !== 'NODE_NOT_ACTIONABLE' || response.error.details?.reason !== 'WINDOW_OBSCURED' || response.error.details.dispatchState !== 'not_sent') fail('OBSCURING_WINDOW_NOT_REFUSED');
          if (actual.touchDownCount !== 0 || actual.gestureCount !== 0 || actual.overlayTouches !== 0 || actual.completed !== false) fail('OBSCURED_SWIPE_WAS_DELIVERED');
        }
        if (actual.panelUpdates < 1 || actual.mainHasFocus !== true || actionCalls !== 1 || uiReads !== 1) fail('MEASUREMENT_CONTRACT_FAILED');
        passed = true;
      } catch (error) { errorCode = safeCode(error.message); }
      finally {
        if (!actual) { try { actual = await oracle(); } catch { /* No raw output. */ } }
        await client?.close();
      }
      const report = { entry, scene, passed, stage, mainWindowStable, panelInactive, panelBoundsChanged, pathObscured, nativeTreeUnchanged,
        actionCalls, uiReads, windowSamples, serviceRevisionAdvanced, mutationReplays: 0, modelCalls: 0,
        panelUpdates: count(actual?.panelUpdates), touchDownCount: count(actual?.touchDownCount), gestureCount: count(actual?.gestureCount),
        wrongGestures: count(actual?.wrongGestures), cancelledGestures: count(actual?.cancelledGestures), overlayTouches: count(actual?.overlayTouches),
        elapsedMs: Math.round(performance.now() - started), ...(errorCode ? { errorCode } : {}),
        ...(response?.error?.code ? { actionError: safeCode(response.error.code) } : {}),
        ...(response?.error?.details?.reason ? { actionReason: safeCode(response.error.details.reason) } : {}) };
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
