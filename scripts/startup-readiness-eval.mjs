#!/usr/bin/env node
// Generic startup observations through production desktop/MCP. No LLM, selector warmup or mutation retry.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeEntry, observation, target } from './native-executor-eval.mjs';
import { acquireDeviceLease } from './testbed-batch.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw new Error(code); };
const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]+$/.test(value) ? value : undefined;

function argumentsOf(argv) {
  const args = { entries: 'desktop,mcp' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') args.help = true;
    else if (['--serial', '--entries', '--scenes', '--output'].includes(argv[index]) && argv[index + 1]) args[argv[index].slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/startup-readiness-eval.mjs --serial emulator-5580 [--entries desktop,mcp] [--scenes startup_blank,startup_never_ready] [--output /tmp/startup-readiness.json]');
    console.log('Requires production receiver with windowReadiness and the testbed debug APK. First native accessibility sample starts the fixture transition; this is not whole-app launch timing.');
    return;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const entries = args.entries.split(',');
  if (!entries.length || new Set(entries).size !== entries.length || entries.some(entry => !['desktop', 'mcp'].includes(entry))) fail('INVALID_ENTRY');
  const definition = JSON.parse(await readFile(path.join(root, 'android/testbed/startup-scenarios.json'), 'utf8'));
  const scenes = args.scenes?.split(',') ?? definition.scenarios.map(scene => scene.id);
  if (!scenes.length || new Set(scenes).size !== scenes.length || scenes.some(id => !definition.scenarios.some(scene => scene.id === id))) fail('UNKNOWN_FIXTURE');
  const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', args.serial, ...command], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const lease = await acquireDeviceLease({ serial: args.serial, runId: randomUUID() });
  const reports = [];
  try {
    for (const entry of entries) for (const scene of scenes) {
      const scenario = definition.scenarios.find(item => item.id === scene);
      const runId = randomUUID();
      const checks = [];
      const check = (code, predicate) => { if (!predicate) checks.push(code); };
      const started = performance.now();
      let client, before, actual, first, action, error, stage = 'connect', readMs = 0, actionCalls = 0;
      let readinessPassed = false, actionOutcome = 'not_exercised', refreshesAfterObservation = 0;
      const oracle = async () => {
        const value = JSON.parse(await adb('exec-out', 'run-as', definition.package, 'cat', definition.oraclePath));
        if (value.runId !== runId || value.scene !== scene) fail('ORACLE_RESULT_MISMATCH');
        return value;
      };
      try {
        // Warm the real transport before launching, never the tested window.
        client = await createNativeEntry(entry, { adbPath, serial: args.serial });
        if ((await client.call('get_device_info', {})).ok !== true) fail('RECEIVER_NOT_CONNECTED');
        stage = 'launch';
        await adb('shell', 'am', 'start', '-S', '-n', definition.activity, '--es', 'scene', scene, '--es', 'runId', runId, '--ei', 'seed', '17');
        // Package-only startup synchronization cannot establish UI readiness.
        const foregroundDeadline = Date.now() + 5000;
        let foreground = false;
        do {
          const current = await client.call('get_current_app', {});
          if (current.ok === true && current.result?.packageName === definition.package) { foreground = true; break; }
          if (current.ok !== true && !['NO_ACTIVE_WINDOW', 'STALE_SNAPSHOT', 'PROTECTED_APP'].includes(current.error?.code)) fail('FIXTURE_FOREGROUND_FAILED');
          await pause(30);
        } while (Date.now() < foregroundDeadline);
        if (!foreground) fail('FIXTURE_NOT_FOREGROUND');
        before = await oracle(); // One precondition sample; never wait for oracle.ready.
        if (before.startupReady !== false || before.completed !== false || before.clickCount !== 0) fail('SETUP_MISSED_STARTUP');
        stage = 'cold_observation';
        const readStarted = performance.now();
        const read = await client.call('get_ui_tree', { maxNodes: 500, maxDepth: 40 });
        readMs = Math.round(performance.now() - readStarted);
        if (read.ok !== true) fail(safeCode(read.error?.code) ?? 'STARTUP_READ_FAILED');
        first = observation(read);
        if (first?.packageName !== definition.package || !Array.isArray(first.nodes)) fail('STARTUP_OBSERVATION_SCOPE');
        actual = await oracle();
        check('STARTUP_CAPABILITY_MISSING', first.observationCapabilities?.windowReadiness === true);
        const readiness = first.readiness;
        check('STARTUP_READINESS_WRONG_STATUS', readiness?.status === scenario.expected);
        check('STARTUP_READINESS_WRONG_REASON', scenario.expected === 'ready' ? readiness?.reason === 'interaction_stable' : readiness?.reason === 'deadline');
        check('STARTUP_NOT_SAMPLED', Number.isInteger(readiness?.samples) && readiness.samples >= 2);
        check('STARTUP_TRANSITION_NOT_EXERCISED', actual.gateStarted === true && actual.probeReads >= 1 && before.startupReady === false);
        check('STARTUP_EXCEEDED_BOUND', readMs <= definition.readinessBudgetMs + 1500 && readiness?.waitedMs <= definition.readinessBudgetMs + 600);
        if (scenario.expected === 'ready') {
          check('STARTUP_RETURNED_BEFORE_READY', actual.startupReady === true && actual.targetMounted === true && actual.animationDone === true);
          check('STARTUP_TREE_NOT_USABLE', first.quality?.status === 'usable');
          if (scenario.kind === 'continuous_collection') check('COLLECTION_DID_NOT_REFRESH', actual.refreshCount >= 10);
          // No selector was supplied to startup readiness. Only now locate the
          // intended synthetic button in that exact returned observation.
          const chosen = target(first, 'startup_target');
          readinessPassed = checks.length === 0;
          if (!checks.length) {
            if (scenario.expectedAction === 'safe_refusal') {
              // The readiness contract can ignore independent list churn; action
              // authorization still protects changed context. Keep the original
              // snapshot and ensure two real fixture updates occurred before tap.
              stage = 'hold_observed_target';
              const refreshBaseline = actual.refreshCount;
              const refreshDeadline = Date.now() + 1000;
              do {
                actual = await oracle();
                refreshesAfterObservation = actual.refreshCount - refreshBaseline;
                if (refreshesAfterObservation >= 2) break;
                await pause(25);
              } while (Date.now() < refreshDeadline);
              if (refreshesAfterObservation < 2) fail('COLLECTION_REFRESH_STOPPED');
            }
            stage = 'single_action';
            actionCalls++;
            action = await client.call('act_and_observe', { action: 'tap_element', arguments: chosen, waitMs: 200 });
            const sent = action.ok === true && action.result?.action?.accepted === true && action.result?.execution?.dispatch === 'sent';
            const refused = action.ok === false && action.error?.code === 'TARGET_CHANGED' &&
              action.error?.details?.reason === 'PAGE_CONTEXT_CHANGED' && action.error?.details?.dispatchState === 'not_sent';
            actionOutcome = sent ? 'dispatched' : refused ? 'safe_refusal' : 'failed';
            check('STARTUP_ACTION_OUTCOME_MISMATCH', actionOutcome === scenario.expectedAction);
            check('STARTUP_ACTION_OBSERVATION_MISSING', observation(action)?.packageName === definition.package);
          }
        } else {
          check('EMPTY_STARTUP_FALSE_READY', actual.startupReady === false && actual.targetMounted === false && first.quality?.status === 'unavailable');
          check('EMPTY_STARTUP_RETURNED_EARLY', readiness?.waitedMs >= definition.readinessBudgetMs - 350);
          check('EMPTY_STARTUP_NO_EVENTS', actual.eventCount >= 5);
          readinessPassed = checks.length === 0;
        }
        stage = 'independent_verification';
        actual = await oracle();
        const expectedClick = scenario.expectedAction === 'dispatched' ? 1 : 0;
        const expectedActionCall = scenario.expectedAction === 'not_exercised' ? 0 : 1;
        check('EARLY_OR_WRONG_CLICK', actual.earlyClicks === 0 && actual.wrongClicks === 0);
        check('DUPLICATE_OR_MISSING_ACTION', actionCalls === expectedActionCall && actual.clickCount === expectedClick);
        check('BUSINESS_COMPLETION_MISMATCH', actual.completed === (scenario.expectedAction === 'dispatched'));
      } catch (failure) { error = safeCode(failure?.message) ?? 'STARTUP_EVALUATION_FAILED'; }
      finally {
        if (!actual) { try { actual = await oracle(); } catch { /* Keep the original setup/observation failure. */ } }
        await client?.close();
      }
      const report = { entry, scene, status: !error && checks.length === 0 ? 'passed' : 'failed', stage,
        modelCalls: 0, actionCalls, mutationReplays: 0, firstReadMs: readMs, durationMs: Math.round(performance.now() - started),
        readinessPassed, actionOutcome, businessCompleted: actual?.completed === true,
        transitionClock: definition.transitionClock, preReadReady: before?.startupReady ?? null,
        readiness: first?.readiness ?? null, quality: first?.quality?.status ?? null, nodeCount: first?.nodes?.length ?? null,
        refreshCount: actual?.refreshCount ?? null, refreshesAfterObservation, eventCount: actual?.eventCount ?? null, probeReads: actual?.probeReads ?? null,
        earlyClicks: actual?.earlyClicks ?? null, wrongClicks: actual?.wrongClicks ?? null, clickCount: actual?.clickCount ?? null,
        oracleCompleted: actual?.completed ?? null, checks, ...(error ? { errorCode: error } : {}),
        ...(safeCode(action?.error?.code) ? { actionError: action.error.code } : {}),
        ...(safeCode(action?.error?.details?.reason) ? { actionReason: action.error.details.reason } : {}),
      };
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    const report = { schemaVersion: 1, suite: 'generic-startup-contract', modelCalls: 0, cases: reports.length,
      passed: reports.filter(item => item.status === 'passed').length, failed: reports.filter(item => item.status === 'failed').length,
      readinessPassed: reports.filter(item => item.readinessPassed).length,
      safeRefusals: reports.filter(item => item.actionOutcome === 'safe_refusal').length,
      businessCompleted: reports.filter(item => item.businessCompleted).length, reports };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reports: undefined }));
    if (report.failed) process.exitCode = 1;
    return report;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'STARTUP_EVALUATION_FAILED'); process.exitCode = 1; });
}
