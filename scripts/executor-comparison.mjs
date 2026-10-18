#!/usr/bin/env node
// Real, sequential AndroidX UI Automator vs shared TapPilot desktop/MCP execution.
// ADB only resets synthetic fixtures, launches instrumentation, and reads its private oracle.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeEntry, observation, target, stableSetupTree, until } from './native-executor-eval.mjs';
import { acquireDeviceLease } from './testbed-batch.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'dev.tappilot.testbed';
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : undefined;

function argumentsOf(argv) {
  const result = { entries: 'uiautomator,desktop,mcp', seeds: '17' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') result.help = true;
    else if (['--serial', '--entries', '--scenes', '--seeds', '--output'].includes(argv[i]) && argv[i + 1]) result[argv[i].slice(2)] = argv[++i];
    else fail('INVALID_ARGUMENT');
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/executor-comparison.mjs --serial emulator-5580 [--entries uiautomator,desktop,mcp] [--seeds 17,29] [--scenes native_refresh,reliability_silent_input] [--output /tmp/executor-comparison.json]');
    console.log('Requires debug receiver, testbed and testbed androidTest APKs. Runs sequentially on an explicitly named isolated emulator. No model or permission changes.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['uiautomator', 'desktop', 'mcp'].includes(entry))) fail('INVALID_ENTRY');
  const seeds = args.seeds.split(',').map(Number);
  if (!seeds.length || seeds.length > 10 || seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 100_000) || new Set(seeds).size !== seeds.length) fail('INVALID_SEED');
  const definition = JSON.parse(await readFile(path.join(root, 'android/testbed/reliability-scenarios.json'), 'utf8'));
  const scenes = args.scenes?.split(',') ?? definition.scenarios.map(scene => scene.id);
  if (!scenes.length || new Set(scenes).size !== scenes.length || scenes.some(scene => !definition.scenarios.some(item => item.id === scene))) fail('UNKNOWN_FIXTURE');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 50_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const lease = await acquireDeviceLease({ serial: args.serial, runId: randomUUID() });
  const reports = [];
  try {
  // No UiAutomation session overlaps a TapPilot action. Each entry gets a newly reset app/run ID.
  for (const entry of entries) for (const scene of scenes) for (const seed of seeds) {
    const scenario = definition.scenarios.find(item => item.id === scene);
    const runId = randomUUID();
    const checks = [];
    const check = (code, condition) => { if (!condition) checks.push(code); };
    const oracle = async () => {
      try {
        const value = JSON.parse(await adb('exec-out', 'run-as', packageName, 'cat', definition.oraclePath));
        return value.runId === runId && value.scene === scene && value.seed === seed ? value : undefined;
      } catch { return undefined; }
    };
    let report;
    if (entry === 'uiautomator') {
      try {
        const output = await adb('shell', 'am', 'instrument', '-w', '-e', 'class',
          'dev.tappilot.testbed.ReliabilityBaselineInstrumentedTest', '-e', 'reliabilityBaseline', 'true',
          '-e', 'scene', scene, '-e', 'seed', String(seed), '-e', 'runId', runId,
          'dev.tappilot.testbed.test/androidx.test.runner.AndroidJUnitRunner');
        const value = JSON.parse(await adb('exec-out', 'run-as', packageName, 'cat', 'files/uiautomator-result.json'));
        if (value.runId !== runId || value.scene !== scene || value.seed !== seed) fail('BASELINE_RESULT_MISMATCH');
        const { runId: _privateRunId, ...fields } = value;
        report = { ...fields, baselineVersion: definition.baseline,
          baselinePolicy: scenario.baselinePolicy ?? 'unique_resource_selector',
          globalIdleTimeoutMs: 0,
          ...(output.includes('FAILURES!!!') && value.status !== 'failed' ? { status: 'failed', fixtureError: 'INSTRUMENTATION_FAILED' } : {}),
        };
      } catch (error) {
        report = { entry, scene, seed, status: 'failed', modelCalls: 0,
          fixtureError: safeCode(error.message) ?? 'BASELINE_INSTRUMENTATION_FAILED' };
      }
    } else {
      const started = performance.now();
      let client, result, actual, fixtureError, actionCalls = 0, setupActionCalls = 0, actionMs = 0, readinessMs = 0, ticksBefore = 0;
      try {
        await adb('shell', 'am', 'start', '-S', '-n', definition.activity, '--es', 'scene', scene, '--ei', 'seed', String(seed), '--es', 'runId', runId);
        await until(async () => (await oracle())?.page === (scene.startsWith('native_') ? 'native_ready' : 'reliability_ready'));
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        await until(async () => (await client.call('get_current_app', {})).result?.packageName === packageName);
        const first = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        if (!first.ok) fail('FIXTURE_READ_FAILED');
        const targetId = scene.startsWith('native_') ? 'native_target' :
          scenario.kind === 'transformed_input' ? 'reliability_input' : 'reliability_target';
        let tree = await stableSetupTree(client, observation(first), [targetId],
          ['native_refresh', 'native_reorder_refresh'].includes(scene) ? ['native_leaf'] : []);
        ticksBefore = (await oracle())?.refreshCount ?? 0;
        if (scenario.change === 'armed') {
          setupActionCalls++;
          const armed = await client.call('act_and_observe', { action: 'tap_element', arguments: target(tree, 'native_arm'), waitMs: 0 });
          if (!armed.ok || armed.result?.action?.accepted !== true) fail('FIXTURE_ARM_FAILED');
          tree = observation(armed);
          target(tree, targetId);
          ticksBefore = (await oracle())?.refreshCount ?? 0;
          if ((await oracle())?.changed) fail('FIXTURE_CHANGE_TOO_EARLY');
          await until(async () => (await oracle())?.changed);
        } else if (scenario.change === 'continuous') {
          const ticks = (await oracle())?.refreshCount ?? 0;
          await until(async () => (await oracle())?.refreshCount >= ticks + 4);
        }
        const actionStarted = performance.now();
        actionCalls++;
        result = await client.call('act_and_observe', {
          action: scenario.kind === 'transformed_input' ? 'input_text' : 'tap_element',
          arguments: { ...target(tree, targetId), ...(scenario.kind === 'transformed_input' ? { text: '中文输入验证' } : {}) },
          waitMs: scenario.kind === 'delayed_input' ? 1500 : 200,
          ...(scenario.kind === 'delayed_input' ? { waitFor: { resourceId: `${packageName}:id/reliability_input`, editable: true } } : {}),
        });
        const firstAction = result;
        if (scenario.kind === 'delayed_input') {
          readinessMs = Math.round(performance.now() - actionStarted);
          const ready = observation(result);
          check('ACTION_DID_NOT_WAIT_FOR_USABLE_INPUT', result.ok === true && ready?.quality?.status === 'usable');
          check('ACTION_READINESS_CONTRACT', result.result?.observationWait?.status === 'matched' && result.result?.observationWait?.ready === true);
          // No harness read/wait may repair an incomplete action observation.
          const inputTarget = target(ready, 'reliability_input');
          actionCalls++;
          result = await client.call('act_and_observe', { action: 'input_text', arguments: { ...inputTarget, text: '中文输入验证' }, waitMs: 200 });
          check('OPEN_REPORTED_BUSINESS_VERIFIED', firstAction.result?.execution?.verification === 'unverified');
        }
        actionMs = Math.round(performance.now() - actionStarted);
        actual = await until(async () => await oracle());
        const execution = result?.result?.execution;
        const dispatched = result?.ok === true && result.result?.action?.accepted === true && execution?.dispatch === 'sent';
        const safeRefusal = result?.ok === false && result.error?.details?.dispatchState === 'not_sent' &&
          ['TARGET_CHANGED', 'STALE_SNAPSHOT', 'NODE_NOT_ACTIONABLE'].includes(result.error?.code);
        check('UNEXPECTED_BUSINESS_COMPLETION', actual.completed === (scenario.expected === 'success'));
        check('WRONG_TARGET', actual.wrongClicks === 0);
        const expectedClicks = scenario.expected === 'refusal' || scenario.kind === 'transformed_input' ? 0 : 1;
        check('DUPLICATE_OR_MISSING_CLICK', actual.clickCount === expectedClicks);
        check('DISPATCH_CONTRACT', scenario.expected === 'refusal' ? safeRefusal : dispatched);
        if (scenario.kind === 'delayed_input') {
          check('INPUT_NOT_VERIFIED', result.result?.action?.textVerified === true && execution?.verification === 'verified');
          check('ORACLE_INPUT_MISMATCH', actual.receivedInput === 'expected' && actual.inputEvents === 1);
          check('READY_WAIT_EXCEEDED_BOUND', readinessMs < 3000);
        }
        if (scenario.kind === 'toggle') check('TOGGLE_NOT_VERIFIED', actual.checked === true && execution?.verification === 'verified');
        if (scenario.kind === 'noop') check('NOOP_FALSE_VERIFICATION', execution?.verification === 'unverified' && execution?.effect === 'unchanged');
        if (scenario.kind === 'transformed_input') {
          check('TRANSFORM_FALSE_VERIFICATION', result.result?.action?.textVerified === false && execution?.verification === 'unverified');
          check('TRANSFORM_ORACLE_MISMATCH', actual.receivedInput === 'other' && actual.inputEvents === 1);
        }
        if (scene === 'reliability_silent_input') check('MISSING_EVENT_FIXTURE_NOT_EXERCISED', actual.suppressedContentEvents > 0);
        if (['native_refresh', 'native_reorder_refresh'].includes(scene)) check('CONTINUOUS_REFRESH_NOT_EXERCISED', actual.refreshCount >= ticksBefore + 4);
        if (['native_reorder', 'native_reorder_refresh'].includes(scene)) check('REORDER_NOT_EXERCISED', actual.orderChangeCount === 1);
      } catch (error) { fixtureError = safeCode(error.message) ?? 'TAPPILOT_COMPARISON_FAILED'; }
      finally { actual ??= await oracle(); await client?.close(); }
      report = { entry, scene, seed, status: !fixtureError && checks.length === 0 ? 'passed' : 'failed',
        modelCalls: 0, actionCalls, setupActionCalls, actionMs, readinessMs, durationMs: Math.round(performance.now() - started),
        oracleCompleted: actual?.completed ?? null, clickCount: actual?.clickCount ?? null,
        wrongClicks: actual?.wrongClicks ?? null, inputEvents: actual?.inputEvents ?? 0,
        refreshCount: actual?.refreshCount ?? 0, suppressedContentEvents: actual?.suppressedContentEvents ?? 0,
        orderChangeCount: actual?.orderChangeCount ?? 0, replacementCount: actual?.replacementCount ?? 0,
        verification: result?.result?.execution?.verification ?? null, effect: result?.result?.execution?.effect ?? null,
        checks, ...(fixtureError ? { fixtureError } : {}),
        ...(safeCode(result?.error?.code) ? { errorCode: result.error.code } : {}),
        ...(safeCode(result?.error?.details?.reason) ? { reason: result.error.details.reason } : {}),
      };
    }
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  const summary = { schemaVersion: 1, baseline: definition.baseline, modelCalls: 0, cases: reports.length,
    passed: reports.filter(item => item.status === 'passed').length, failed: reports.filter(item => item.status === 'failed').length,
    safetyBaseline: 'Explicit fixture recipient/unique-selector assertions; not built-in UI Automator safety.', reports };
  if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, reports: undefined }));
  if (summary.failed) process.exitCode = 1;
  return summary;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error.message) ?? 'EXECUTOR_COMPARISON_FAILED'); process.exitCode = 1; });
}
