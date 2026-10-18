#!/usr/bin/env node
// Real Android + production desktop controller/runtime; scripted model, no external LLM.
// Synthetic Canvas image-centre points only. Never save images, UI, handles or model bodies.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientTools } from '../server/dist/client-tools.js';
import { runAgent } from '../server/dist/runtime/index.js';
import { signature } from '../server/dist/runtime/context.js';
import { PhoneScreenshotSchema } from '../server/dist/screenshot.js';
import { createNativeEntry, observation, until } from './native-executor-eval.mjs';
import { acquireDeviceLease } from './testbed-batch.mjs';

const exec = promisify(execFile);
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value) ? value : 'VISUAL_RECHECK_EVAL_FAILED';
const pkg = 'dev.tappilot.testbed', scene = 'visual_action_chain';
const expectedCalls = ['get_ui_tree', 'wait_for_ui_change', 'take_screenshot', 'get_ui_tree', 'act_and_observe', 'get_ui_tree', 'act_and_observe', 'get_ui_tree'];
const fixedEnum = (value, allowed) => allowed.includes(value) ? value : 'unknown';
// Mirror the runtime's semantic comparison, but retain only equality booleans in
// the report. Neither the UI, its digest, nor identifiers leave this process.
function observationEvidence(value) {
  const nodes = value.nodes.filter(node => node && typeof node === 'object' && !Array.isArray(node));
  const positions = new Map(nodes.map((node, index) => [node.nodeId, index]));
  const separator = typeof value.snapshotId === 'string' ? value.snapshotId.lastIndexOf(':') : -1;
  return { packageName: value.packageName, windowId: value.windowId,
    session: separator > 0 ? value.snapshotId.slice(0, separator) : undefined,
    digest: signature({ ...value, nodes: nodes.map(({ nodeId: _id, parentId, ...node }) => ({ ...node,
      ...(parentId != null ? { parentId: positions.get(parentId) ?? 'unobserved' } : {}) })) }) };
}
function capture(value) {
  if (!value) fail('VISUAL_IMAGE_MISSING');
  const { image, ...metadata } = value;
  const parsed = PhoneScreenshotSchema.safeParse({ ...metadata, data: image?.data });
  if (!parsed.success || parsed.data.packageName !== pkg || parsed.data.source !== 'window' ||
      parsed.data.observationOnly !== false || parsed.data.actionContract !== 'visual-tap-v1') fail('INVALID_VISUAL_CAPTURE');
  return { captureId: parsed.data.captureId, width: parsed.data.width, height: parsed.data.height };
}
const answer = (turn, call) => new Response(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: {
  role: 'assistant', content: call ? null : 'Synthetic native page is visible.',
  ...(call ? { tool_calls: [{ id: `synthetic-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}),
} }] }), { headers: { 'Content-Type': 'application/json' } });

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (['--serial', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const sdk = Number(await adb('shell', 'getprop', 'ro.build.version.sdk'));
  if (!Number.isInteger(sdk) || sdk < 34) fail('WINDOW_SCREENSHOT_EVAL_REQUIRES_API_34');
  const runId = randomUUID(), started = performance.now();
  const lease = await acquireDeviceLease({ serial: args.serial, runId });
  const calls = [], preservedRechecks = [], observationDiagnostics = [];
  let client, latestCapture, firstCaptureId, result, errorCode, modelError, actual, previousEvidence, toolSequenceMismatch;
  let passed = false, modelCalls = 0, actions = 0, initialCaptures = 0, followupImages = 0, nativeRecovered = false, imageRemovedOnNative = false;
  const oracle = async () => {
    const state = JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json'));
    if (state.runId !== runId || state.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
    return state;
  };
  try {
    client = await createNativeEntry('desktop', { adbPath, serial: args.serial });
    await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '17');
    await until(async () => { try { return (await oracle()).page === 'visual_canvas_1'; } catch { return false; } });
    await until(async () => (await client.call('get_current_app', {})).result?.packageName === pkg);
    const baseline = await oracle();
    if (baseline.clickCount !== 0 || baseline.wrongClicks !== 0 || baseline.completed !== false) fail('BASELINE_NOT_EMPTY');
    // Startup capture rate boundary only, before the measured runtime begins.
    await new Promise(resolve => setTimeout(resolve, 1100));
    result = await runAgent({ task: 'Open both synthetic pages and report the native page.',
      model: { baseUrl: 'https://synthetic.invalid/v1', apiKey: '', model: 'scripted-fixture', vision: true },
      tools: clientTools, maxTurns: 5, signal: AbortSignal.timeout(60_000),
      execute: async (name, input, signal) => {
        signal.throwIfAborted();
        calls.push(name);
        // Fail before forwarding any unwanted recovery, extra screenshot or replay.
        if (name !== expectedCalls[calls.length - 1]) {
          toolSequenceMismatch = { index: calls.length - 1,
            expected: fixedEnum(expectedCalls[calls.length - 1], expectedCalls), actual: fixedEnum(name, expectedCalls) };
          fail('UNEXPECTED_RUNTIME_TOOL_SEQUENCE');
        }
        const response = await client.call(name, input);
        if (response.ok !== true) fail(safeCode(response.error?.code));
        const observedForDiagnostics = observation(response);
        if (Array.isArray(observedForDiagnostics?.nodes)) {
          const current = observationEvidence(observedForDiagnostics);
          observationDiagnostics.push({ call: fixedEnum(name, expectedCalls), modelTurn: modelCalls,
            nodeCount: observedForDiagnostics.nodes.length, truncated: observedForDiagnostics.truncated === true,
            complete: observedForDiagnostics.truncated === false,
            qualityStatus: fixedEnum(observedForDiagnostics.quality?.status, ['usable', 'limited', 'unavailable']),
            qualityReason: fixedEnum(observedForDiagnostics.quality?.reason, ['accessible_content', 'incomplete_tree', 'no_accessible_content']),
            readinessStatus: fixedEnum(observedForDiagnostics.readiness?.status, ['ready', 'settling']),
            readinessReason: fixedEnum(observedForDiagnostics.readiness?.reason, ['interaction_stable', 'known_window', 'deadline']),
            samePackage: previousEvidence ? current.packageName === previousEvidence.packageName : null,
            sameWindow: previousEvidence ? current.windowId === previousEvidence.windowId : null,
            sameSession: previousEvidence ? current.session !== undefined && current.session === previousEvidence.session : null,
            sameSemantics: previousEvidence ? current.digest === previousEvidence.digest : null });
          previousEvidence = current;
        }
        if (name === 'take_screenshot') {
          initialCaptures++;
          latestCapture = capture(response.result);
          firstCaptureId = latestCapture.captureId;
        } else if (name === 'act_and_observe') {
          actions++;
          if (input.action !== 'tap_visual' || response.result?.action?.accepted !== true || response.result.action.dispatchState !== 'sent') fail('VISUAL_ACTION_NOT_ACCEPTED');
          const observed = observation(response);
          if (observed?.packageName !== pkg || response.result.observationError || response.result.visualObservationError) fail('ACTION_OBSERVATION_MISSING');
          actual = await oracle();
          if (actual.clickCount !== actions || actual.wrongClicks !== 0) fail('ACTION_ORACLE_MISMATCH');
          if (actions === 1) {
            if (observed.quality?.status !== 'unavailable' || actual.page !== 'visual_canvas_2') fail('FIRST_CANVAS_NOT_OBSERVED');
            latestCapture = capture(response.result.visualObservation);
            followupImages++;
            if (latestCapture.captureId === firstCaptureId) fail('FOLLOWUP_CAPTURE_NOT_FRESH');
          } else {
            nativeRecovered = observed.quality?.status === 'usable' && observed.nodes?.some(node =>
              node.resourceId === `${pkg}:id/visual_action_native_target` && node.clickable === true && node.enabled === true) === true;
            if (!nativeRecovered || response.result.visualObservation || actual.page !== 'visual_native_ready' || actual.completed !== true) fail('NATIVE_UI_NOT_IN_ACTION_RESPONSE');
          }
        } else {
          const observed = observation(response);
          if (observed?.packageName !== pkg || observed.truncated !== false || observed.quality?.status !== (actions === 2 ? 'usable' : 'unavailable')) fail('UNEXPECTED_RECHECK_OBSERVATION');
        }
        return response;
      },
      modelFetch: async (_url, init) => {
        try {
          modelCalls++;
          const body = JSON.parse(String(init.body));
          const images = body.messages.filter(message => Array.isArray(message.content));
          const offered = body.tools.find(tool => tool.function.name === 'act_and_observe')?.function.parameters.properties.action.enum ?? [];
          if (modelCalls <= 4) {
            if (images.length !== 1 || !latestCapture || !images[0].content.some(part => part.type === 'text' && part.text.includes(latestCapture.captureId)) || !offered.includes('tap_visual')) fail('CURRENT_IMAGE_OR_HANDLE_LOST');
            if (modelCalls === 1 || modelCalls === 3) return answer(modelCalls, { name: 'get_ui_tree', args: {} });
            preservedRechecks.push(true);
            // Only this fixture's deliberately centred Canvas button. No real-app coordinates.
            return answer(modelCalls, { name: 'act_and_observe', args: { action: 'tap_visual', arguments: {
              captureId: latestCapture.captureId, x: Math.floor(latestCapture.width / 2), y: Math.floor(latestCapture.height / 2),
              targetDescription: 'Open the synthetic next page',
            }, waitMs: 350 } });
          }
          imageRemovedOnNative = images.length === 0 && !offered.includes('tap_visual') && offered.includes('tap_element');
          if (modelCalls !== 5 || !nativeRecovered || !imageRemovedOnNative) fail('NATIVE_MODEL_CONTEXT_NOT_RESTORED');
          return answer(modelCalls);
        } catch (error) { modelError = safeCode(error.message); throw error; }
      },
    });
    actual = await oracle();
    if (result.status !== 'completed') fail(modelError ?? safeCode(result.error?.match(/^([A-Z_0-9]+)/)?.[1]));
    if (JSON.stringify(calls) !== JSON.stringify(expectedCalls) || modelCalls !== 5 || preservedRechecks.length !== 2 || initialCaptures !== 1 || followupImages !== 1 || actions !== 2) fail('RUNTIME_COUNTS_MISMATCH');
    if (actual.clickCount !== 2 || actual.wrongClicks !== 0 || actual.completed !== true || actual.page !== 'visual_native_ready') fail('FINAL_ORACLE_MISMATCH');
    passed = true;
  } catch (error) { errorCode = safeCode(error.message); }
  finally {
    try { actual = await oracle(); } catch { /* Preserve the last fixed oracle state, never raw output. */ }
    await client?.close();
    await lease.release();
  }
  const report = { entry: 'desktop-runtime', scene, passed, scriptedModelCalls: modelCalls, externalModelCalls: 0,
    toolCalls: calls.length, uiReads: calls.filter(name => name === 'get_ui_tree').length,
    waits: calls.filter(name => name === 'wait_for_ui_change').length, initialCaptures, followupImages, actions,
    preservedRechecks: preservedRechecks.length, nativeRecovered, imageRemovedOnNative,
    observationDiagnostics, ...(toolSequenceMismatch ? { toolSequenceMismatch, harnessError: 'UNEXPECTED_RUNTIME_TOOL_SEQUENCE' } : {}),
    clickCount: Number.isSafeInteger(actual?.clickCount) ? actual.clickCount : null,
    wrongClicks: Number.isSafeInteger(actual?.wrongClicks) ? actual.wrongClicks : null,
    elapsedMs: Math.round(performance.now() - started), ...(errorCode ? { errorCode } : {}), ...(modelError ? { modelError } : {}) };
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!passed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error.message)); process.exitCode = 1; });
}
