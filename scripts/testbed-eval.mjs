#!/usr/bin/env node
// Independent Android fixture oracle. No oracle values enter model messages or phone tools.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'dev.tappilot.testbed';

export function evaluateOracle(scenario, runId, actual) {
  if (actual?.schemaVersion !== 1 || actual?.runId !== runId || actual?.scene !== scenario.id || actual?.seed !== scenario.seed) {
    return { fresh: false, success: false, mismatches: ['identity'] };
  }
  const mismatches = Object.entries(scenario.expected).filter(([key, value]) => actual[key] !== value).map(([key]) => key);
  return { fresh: true, success: mismatches.length === 0, mismatches };
}

function latestObservation(body) {
  const found = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.snapshotId === 'string' && Array.isArray(value.nodes)) found.push(value);
    else for (const nested of Object.values(value)) visit(nested);
  }
  for (const message of body.messages ?? []) if (message.role === 'tool' && message.content) {
    try { visit(JSON.parse(message.content)); } catch { /* Non-JSON host messages carry no observation. */ }
  }
  return found.at(-1);
}

/** Deterministic fixture policy reads the production model projection, never expected oracle state. */
export function chooseFixtureAction(scene, tree) {
  if (!tree || tree.packageName !== packageName) throw new Error('FIXTURE_UI_MISSING');
  const nodes = tree.nodes.filter(node => node.visible !== false && node.enabled !== false);
  const has = text => nodes.some(node => node.text === text);
  const by = (test, capability) => {
    const candidates = nodes.filter(node => test(node) && (!capability || node[capability] === true));
    if (candidates.length !== 1) throw new Error('FIXTURE_TARGET_AMBIGUOUS');
    return candidates[0];
  };
  const target = node => ({ snapshotId: tree.snapshotId, nodeId: node.nodeId });
  const tap = text => ({ action: 'tap_element', arguments: target(by(node => node.text === text, 'clickable')) });
  const input = (node, text) => ({ action: 'input_text', arguments: { ...target(node), text } });
  if (scene === 'navigation') {
    if (has('合成电池电量：73%')) return null;
    return tap(has('打开测试目录') ? '打开测试目录' : '合成电池');
  }
  if (scene === 'search') {
    if (has('合成商品：电池，价格 42 元')) return null;
    if (has('查看合成电池')) return tap('查看合成电池');
    const editor = by(node => node.rid === 'id/search_input', 'editable');
    return editor.text === '合成电池' ? tap('搜索') : input(editor, '合成电池');
  }
  if (scene === 'async_list') return has('已打开合成目标 B') ? null : tap('合成目标 B');
  if (scene === 'ime') {
    if (has('合成草稿已保存')) return null;
    if (!has('合成会话甲')) throw new Error('FIXTURE_RECIPIENT_CHANGED');
    const editor = by(node => node.rid === 'id/ime_input', 'editable');
    if (editor.focused !== true) return tap('打开键盘');
    return editor.text === '合成输入' ? tap('保存草稿') : input(editor, '合成输入');
  }
  if (scene === 'overlay') {
    if (has('已打开被遮挡目标')) return null;
    return tap(has('关闭浮层') ? '关闭浮层' : '打开被遮挡目标');
  }
  if (scene === 'long_list') {
    if (has('合成项目 42 的详细信息')) return null;
    if (has('合成项目 42')) return tap('合成项目 42');
    const scroller = by(node => node.scrollable === true, 'scrollable');
    return { action: 'scroll', arguments: { ...target(scroller), direction: 'forward' } };
  }
  if (scene === 'webview') {
    if (has('合成网页已保存')) return null;
    if (!nodes.some(node => node.editable === true)) return { tool: 'wait_for_ui_change', arguments: {
      sinceRevision: tree.revision, timeoutMs: 1500, selector: { editable: true },
    } };
    const editor = by(node => node.editable === true, 'editable');
    return editor.text === '合成网页' ? tap('保存网页内容') : input(editor, '合成网页');
  }
  if (scene === 'canvas') return null; // No visual tool in this production client; never guess coordinates.
  throw new Error('UNKNOWN_FIXTURE');
}

function argumentsOf(argv) {
  const result = { mode: 'fixture', repeat: 1, scenes: undefined, seeds: undefined, serial: undefined, output: undefined, allowPhysical: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-physical') result.allowPhysical = true;
    else if (arg === '--help') result.help = true;
    else if (['--mode', '--repeat', '--scenes', '--seeds', '--serial', '--output'].includes(arg) && argv[i + 1]) {
      result[arg.slice(2)] = argv[++i];
    } else throw new Error('INVALID_ARGUMENT');
  }
  result.repeat = Number(result.repeat);
  if (!['fixture', 'model'].includes(result.mode) || !Number.isInteger(result.repeat) || result.repeat < 1 || result.repeat > 20) throw new Error('INVALID_ARGUMENT');
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/testbed-eval.mjs --serial emulator-5580 [--mode fixture|model] [--scenes navigation,search] [--seeds 17,29] [--repeat 3] [--output /path/report.json]');
    console.log('Model mode uses TAPPILOT_EVAL_BASE_URL, TAPPILOT_EVAL_MODEL, TAPPILOT_EVAL_API_KEY. Service permission and local Allow are prerequisites; this harness never grants them.');
    return;
  }
  if (!args.serial || (!/^emulator-\d+$/.test(args.serial) && !args.allowPhysical)) throw new Error('EXPLICIT_TEST_DEVICE_REQUIRED');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const definitions = JSON.parse(await readFile(path.join(root, 'android/testbed/scenarios.json'), 'utf8'));
  const selected = args.scenes ? args.scenes.split(',') : definitions.scenarios.map(scenario => scenario.id);
  if (selected.some(id => !definitions.scenarios.some(scenario => scenario.id === id))) throw new Error('UNKNOWN_FIXTURE');
  const seeds = args.seeds?.split(',').map(Number);
  if (seeds?.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647)) throw new Error('INVALID_SEED');
  const model = args.mode === 'fixture' ? { baseUrl: 'https://synthetic-model.invalid/v1', model: 'fixture', apiKey: '' } : {
    baseUrl: process.env.TAPPILOT_EVAL_BASE_URL, model: process.env.TAPPILOT_EVAL_MODEL, apiKey: process.env.TAPPILOT_EVAL_API_KEY ?? '',
  };
  if (!model.baseUrl || !model.model) throw new Error('MODEL_CONFIG_REQUIRED');
  const { createPhoneClient } = await import(pathToFileURL(path.join(root, 'server/dist/client-tools.js')));
  const { Adb } = await import(pathToFileURL(path.join(root, 'server/dist/adb.js')));
  const { Bridge } = await import(pathToFileURL(path.join(root, 'server/dist/bridge.js')));
  const createTestClient = async () => {
    const access = new Adb({ executable: adbPath, serial: args.serial, allowEmulator: /^emulator-\d+$/.test(args.serial) });
    await access.select();
    return createPhoneClient(new Bridge(access), access);
  };
  const { runAgent, endpointFor } = await import(pathToFileURL(path.join(root, 'server/dist/runtime/index.js')));
  endpointFor(model);
  const preflight = await createTestClient();
  try {
    const device = await preflight.execute('get_device_info', {}, new AbortController().signal);
    const bridge = device.result?.bridge?.result;
    if (!device.ok || !bridge?.serviceConnected || bridge.stopped !== false || bridge.locked !== false) throw new Error('SERVICE_NOT_READY');
  } finally { await preflight.close(); }

  const reports = [];
  for (const id of selected) for (const seed of seeds ?? [definitions.scenarios.find(scenario => scenario.id === id).seed]) for (let repetition = 1; repetition <= args.repeat; repetition++) {
    const scenario = { ...definitions.scenarios.find(scenario => scenario.id === id), seed };
    const runId = randomUUID();
    // The only ADB mutation initializes this isolated fixture; never inject taps/text/swipes with ADB.
    await adb('shell', 'am', 'start', '-S', '-n', definitions.activity, '--es', 'scene', id, '--ei', 'seed', String(seed), '--es', 'runId', runId);
    const oracle = async () => JSON.parse(await adb('exec-out', 'run-as', packageName, 'cat', definitions.oraclePath));
    let initial;
    const resetDeadline = Date.now() + 5_000;
    do {
      try { initial = await oracle(); } catch { initial = undefined; }
      if (initial?.runId === runId && initial.scene === id && initial.seed === seed && Object.entries(scenario.initial).every(([key, value]) => initial[key] === value)) break;
      await new Promise(resolve => setTimeout(resolve, 60));
    } while (Date.now() < resetDeadline);
    if (!initial || initial.runId !== runId || !Object.entries(scenario.initial).every(([key, value]) => initial[key] === value)) throw new Error('FIXTURE_RESET_FAILED');

    const client = await createTestClient();
    let modelRound = 0, mutations = 0, fixtureError;
    const errors = [];
    const modelFetch = args.mode === 'fixture' ? async (_url, init) => {
      try {
        const tree = latestObservation(JSON.parse(init.body));
        const action = chooseFixtureAction(id, tree);
        return new Response(JSON.stringify({ choices: [{ finish_reason: action ? 'tool_calls' : 'stop', message: {
          role: 'assistant', content: action ? null : id === 'canvas' ? '当前没有视觉定位工具，无法安全操作此自绘按钮。' : '已完成当前合成测试目标。',
          ...(action ? { tool_calls: [{ id: `fixture-${++modelRound}`, type: 'function', function: {
            name: action.tool ?? 'act_and_observe', arguments: JSON.stringify(action.tool ? action.arguments : action),
          } }] } : {}),
        } }] }));
      } catch (error) { fixtureError = /^[A-Z_]+$/.test(error.message) ? error.message : 'FIXTURE_POLICY_FAILED'; throw error; }
    } : undefined;
    let result;
    try {
      // Oracle initialization precedes Android window focus, especially for WebView.
      // Wait through the production read-only channel before starting model evaluation.
      let foregroundReady = false;
      const foregroundDeadline = Date.now() + 5_000;
      do {
        const current = await client.execute('get_current_app', {}, AbortSignal.timeout(5_000));
        foregroundReady = current.ok === true && current.result?.packageName === packageName;
        if (foregroundReady) break;
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < foregroundDeadline);
      if (!foregroundReady) throw new Error('FIXTURE_WINDOW_NOT_READY');
      result = await runAgent({ task: scenario.task, model, tools: client.tools, modelFetch, maxTurns: 40,
        signal: AbortSignal.timeout(240_000),
        execute: async (name, actionArgs, signal) => {
          if (name === 'act_and_observe') {
            if (!['tap_element', 'click_element', 'input_text', 'scroll', 'swipe'].includes(actionArgs.action)) {
              return { ok: false, error: { code: 'MANUAL_ACTION_REQUIRED', message: 'The fixture harness does not authorize navigation outside its synthetic app.', retryable: false } };
            }
            mutations++;
          }
          const value = await client.execute(name, actionArgs, signal);
          const observed = value.result?.observation ?? value.observation ?? value.result;
          if (observed?.packageName && observed.packageName !== packageName) throw new Error('FIXTURE_APP_LEFT');
          return value;
        },
        onEvent: event => { if (typeof event.errorCode === 'string' && /^[A-Z_0-9]+$/.test(event.errorCode)) errors.push(event.errorCode); },
      });
    } finally { await client.close(); }
    let final;
    try { final = await oracle(); } catch { final = await oracle(); }
    const evaluation = evaluateOracle(scenario, runId, final);
    const unsupported = Boolean(scenario.requiresVision);
    // Only the deterministic policy has a known refusal response. Never infer a real
    // model's success/refusal solely from its runtime-completed status.
    const safeRejection = unsupported && args.mode === 'fixture' && mutations === 0 && evaluation.fresh && final.wrongClicks === 0 && final.completed === false;
    const status = evaluation.success ? 'success' : safeRejection ? 'unsupported_safe_rejection' : result.status === 'completed' ? 'false_completion' : 'failed';
    const report = { scene: id, seed, repetition, runId, mode: args.mode, status, runtimeStatus: result.status,
      oracleFresh: evaluation.fresh, mismatches: evaluation.mismatches, wrongClicks: final.wrongClicks ?? null,
      mutations, errors, ...(fixtureError ? { fixtureError } : {}), metrics: result.metrics };
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  const summary = { schemaVersion: 1, mode: args.mode, cases: reports.length,
    success: reports.filter(row => row.status === 'success').length,
    unsupportedSafeRejection: reports.filter(row => row.status === 'unsupported_safe_rejection').length,
    falseCompletion: reports.filter(row => row.status === 'false_completion').length,
    failed: reports.filter(row => row.status === 'failed').length, reports };
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, reports: undefined }));
  if (summary.failed || summary.falseCompletion) process.exitCode = 1;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // No command stderr, model endpoint, key, response body, or actual UI content is logged.
    console.error(/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'TESTBED_EVAL_FAILED');
    process.exitCode = 1;
  });
}
