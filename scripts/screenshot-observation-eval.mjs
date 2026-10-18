#!/usr/bin/env node
// Isolated synthetic Android fixtures only. No model, user data, input injection or screenshot files.
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
import { until } from './native-executor-eval.mjs';

const exec = promisify(execFile);
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : 'SCREENSHOT_EVAL_FAILED';
const pkg = 'dev.tappilot.testbed';
const scenes = ['semantic_blank', 'screenshot_secure', 'screenshot_password'];

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (['--serial', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const sdk = Number(await adb('shell', 'getprop', 'ro.build.version.sdk'));
  if (!Number.isInteger(sdk) || sdk < 34) fail('WINDOW_SCREENSHOT_EVAL_REQUIRES_API_34');
  const reports = [];
  for (const entry of ['desktop', 'mcp']) for (const scene of scenes) {
    const runId = randomUUID();
    let client, errorCode, imageBytes = 0, captureCalls = 0, passed = false;
    try {
      // Only reset the named synthetic test app on the explicitly selected emulator.
      await adb('shell', 'am', 'start', '-S', '-n', `${pkg}/.MainActivity`, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '17');
      const oracle = async () => {
        try { return JSON.parse(await adb('exec-out', 'run-as', pkg, 'cat', 'files/oracle.json')); } catch { return undefined; }
      };
      await until(async () => { const value = await oracle(); return value?.runId === runId && value.scene === scene && value.page === 'semantic_ready'; });
      const access = new Adb({ executable: adbPath, serial: args.serial, allowEmulator: true });
      await access.select();
      const transport = new Bridge(access);
      const bridge = { close: () => transport.close(), call: (name, ...rest) => {
        if (name === 'take_screenshot') captureCalls++;
        return transport.call(name, ...rest);
      } };
      const controller = entry === 'mcp' ? new ToolController(bridge, access, new ApprovalQueue(), 'trusted') : undefined;
      const desktop = entry === 'desktop' ? createPhoneClient(bridge, access) : undefined;
      client = { call: async (name, input) => {
        if (desktop) return { body: await desktop.execute(name, input, AbortSignal.timeout(10_000)) };
        const result = await controller.invoke(name, input);
        return { body: result.structuredContent, content: result.content };
      }, close: () => desktop ? desktop.close() : controller.close() };
      await until(async () => (await client.call('get_current_app', {})).body?.result?.packageName === pkg);
      const tree = (await client.call('get_ui_tree', {})).body;
      if (tree.ok !== true || tree.result.packageName !== pkg) fail('FIXTURE_READ_FAILED');
      if (scene === 'semantic_blank' && tree.result.quality?.status !== 'unavailable') fail('CANVAS_NOT_INACCESSIBLE');
      // One fixture-settle boundary also honors Android's capture rate gate between independent cases.
      await new Promise(resolve => setTimeout(resolve, 1100));
      const capture = await client.call('take_screenshot', {});
      if (scene === 'semantic_blank') {
        if (capture.body?.ok !== true) fail(safeCode(capture.body?.error?.code));
        const metadata = capture.body.result;
        const image = entry === 'desktop' ? metadata.image : capture.content.find(item => item.type === 'image');
        const { image: _image, ...clean } = metadata;
        const parsed = PhoneScreenshotSchema.safeParse({ ...clean, data: image?.data });
        if (!parsed.success || parsed.data.packageName !== pkg || parsed.data.source !== 'window' ||
            'snapshotId' in metadata || 'nodes' in metadata) fail('INVALID_SCREENSHOT_CONTRACT');
        if (entry === 'mcp' && (JSON.stringify(capture.body).includes(image.data) ||
            capture.content.filter(item => item.type === 'image').length !== 1 ||
            JSON.stringify(capture.content.filter(item => item.type === 'text')).includes(image.data))) fail('IMAGE_DUPLICATED_IN_TEXT');
        imageBytes = Buffer.from(image.data, 'base64').length;
      } else {
        const expected = scene === 'screenshot_secure' ? 'SCREENSHOT_PROTECTED' : 'SENSITIVE_FIELD';
        if (capture.body?.ok !== false || capture.body?.error?.code !== expected ||
            capture.content?.some(item => item.type === 'image') || capture.body?.result) fail('PROTECTED_PIXELS_EXPOSED_OR_WRONG_ERROR');
        errorCode = expected;
      }
      const actual = await oracle();
      if (captureCalls !== 1 || actual?.clickCount !== 0 || actual?.wrongClicks !== 0 || actual?.completed !== false) fail('OBSERVATION_CHANGED_BUSINESS_STATE');
      passed = true;
    } catch (error) { errorCode = safeCode(error.message); }
    finally { await client?.close(); }
    // Fixed metadata only. Never persist pixels, UI strings, provider output or raw errors.
    const report = { entry, scene, passed, captureCalls, imageBytes, modelCalls: 0, ...(errorCode ? { errorCode } : {}) };
    reports.push(report); console.log(JSON.stringify(report));
  }
  const report = { cases: reports.length, passed: reports.filter(item => item.passed).length, failed: reports.filter(item => !item.passed).length, reports };
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reports: undefined }));
  if (report.failed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error.message)); process.exitCode = 1; });
}
