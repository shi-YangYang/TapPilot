import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDeviceLease, openBatchJournal, BatchBudget, BatchError, batchHash } from './testbed-batch.mjs';
import { evaluationFinishTool, parseFinishDeclaration, evaluateCase, createStepEvidence, extractObservation, oracleMatchesIdentity, observedCoverage, observedActionCoverage } from './testbed-verifier.mjs';
import { generateCase, chooseVariantAction, summarizeVariantDiversity } from './testbed-scenarios.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePackage = 'dev.tappilot.testbed';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw new BatchError(code); };
const safeCode = error => /^[A-Z][A-Z_0-9]{0,63}$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'EVALUATION_FAILED';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const modelFinishInstruction = '\n任务结束时必须调用 finish_evaluation 明确报告 completed 或 cannot_complete，不能仅用自然语言结束；只有观察到任务效果才报告 completed。工具声明不证明成功，测试系统会独立判定。';
const allowedActions = new Set(['tap_element', 'click_element', 'input_text', 'scroll', 'swipe']);
const terminalEnvironment = new Set(['DEVICE_UNAUTHORIZED', 'NO_DEVICE', 'DEVICE_NOT_FOUND', 'SERVICE_NOT_READY', 'SERVICE_UNAVAILABLE', 'DEVICE_LOCKED', 'EMERGENCY_STOPPED', 'ADB_FAILED', 'BRIDGE_UNAVAILABLE', 'CASE_CLEANUP_PENDING']);

export function parseArguments(argv) {
  const args = { mode: 'fixture', suite: 'generated', split: 'regression', repeat: 1, seeds: '17,29,43',
    maxCases: 500, maxModelRequests: 200, maxMinutes: 30, caseTimeoutMs: 240_000, resume: false, listCases: false, decisionDelayMs: 0 };
  const names = { '--mode': 'mode', '--suite': 'suite', '--split': 'split', '--repeat': 'repeat', '--scenes': 'scenes', '--seeds': 'seeds',
    '--serial': 'serial', '--output': 'output', '--max-cases': 'maxCases', '--max-model-requests': 'maxModelRequests',
    '--max-minutes': 'maxMinutes', '--case-timeout-ms': 'caseTimeoutMs', '--manifest': 'manifest', '--case-ids': 'caseIds', '--decision-delay-ms': 'decisionDelayMs' };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--help') args.help = true;
    else if (name === '--resume') args.resume = true;
    else if (name === '--list-cases') args.listCases = true;
    else if (names[name] && argv[index + 1]) args[names[name]] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  for (const [key, max] of Object.entries({ repeat: 20, maxCases: 10000, maxModelRequests: 100000, maxMinutes: 1440, caseTimeoutMs: 600000 })) {
    args[key] = Number(args[key]);
    if (!Number.isSafeInteger(args[key]) || args[key] < 1 || args[key] > max) fail('INVALID_ARGUMENT');
  }
  if (!['fixture', 'model'].includes(args.mode) || !['legacy', 'generated'].includes(args.suite) || !['regression', 'holdout'].includes(args.split)) fail('INVALID_ARGUMENT');
  args.decisionDelayMs = Number(args.decisionDelayMs);
  if (!Number.isSafeInteger(args.decisionDelayMs) || args.decisionDelayMs < 0 || args.decisionDelayMs > 30000
    || args.mode !== 'fixture' && args.decisionDelayMs !== 0) fail('INVALID_ARGUMENT');
  args.seeds = args.seeds.split(',').map(Number);
  if (!args.seeds.length || args.seeds.length > 1000 || args.seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) || new Set(args.seeds).size !== args.seeds.length) fail('INVALID_SEED');
  if (args.resume && !args.output) fail('OUTPUT_REQUIRED_FOR_RESUME');
  return args;
}

export function makeCases(definitions, args) {
  const scenes = args.scenes?.split(',') ?? definitions.scenarios.map(scene => scene.id);
  if (new Set(scenes).size !== scenes.length || scenes.some(id => !definitions.scenarios.some(scene => scene.id === id))) fail('UNKNOWN_FIXTURE');
  const cases = [];
  for (const scene of scenes) for (const seed of args.seeds) for (let repetition = 1; repetition <= args.repeat; repetition++) {
    const definition = definitions.scenarios.find(value => value.id === scene);
    const scenario = args.suite === 'generated' ? generateCase(definition, seed, { split: args.split })
      : { ...definition, seed, expectedOutcome: definition.requiresVision ? 'unavailable' : 'complete', coverage: ['legacy'] };
    cases.push({ scenario, repetition, caseId: `${args.suite}-${args.split}-${scene}-${seed}-${repetition}` });
  }
  const selected = args.caseIds?.split(',');
  if (selected?.some(id => !cases.some(value => value.caseId === id))) fail('UNKNOWN_CASE');
  return selected ? cases.filter(value => selected.includes(value.caseId)) : cases;
}

export function summarizeReports(reports, total, budget, stopReason, interruptedAttempts = []) {
  const statuses = {};
  const configuredCoverage = {}, actualCoverage = {};
  const actionEvidence = { calls: 0, failedCalls: 0, confirmedNotSent: 0, unknownDispatch: 0, errors: {} };
  for (const report of reports) {
    statuses[report.status] = (statuses[report.status] ?? 0) + 1;
    for (const tag of report.coverage ?? []) configuredCoverage[tag] = (configuredCoverage[tag] ?? 0) + 1;
    for (const tag of report.observedCoverage ?? []) actualCoverage[tag] = (actualCoverage[tag] ?? 0) + 1;
    for (const step of report.steps ?? []) {
      if (!step.action) continue;
      actionEvidence.calls++;
      if (step.ok === false) actionEvidence.failedCalls++;
      if (step.dispatchState === 'not_sent') actionEvidence.confirmedNotSent++;
      if (step.dispatchState === 'unknown') actionEvidence.unknownDispatch++;
      if (step.error) actionEvidence.errors[step.error] = (actionEvidence.errors[step.error] ?? 0) + 1;
    }
  }
  return { schemaVersion: 2, total, completedCases: reports.length, pendingCases: total - reports.length, statuses, configuredCoverage, observedCoverage: actualCoverage,
    wrongClicks: reports.reduce((sum, report) => sum + (report.wrongClicks ?? 0), 0), actionEvidence, budget,
    ...(stopReason ? { stopReason } : {}), interruptedAttempts, reports };
}

// A runtime deadline may win its Promise.race while an execute callback is still unwinding.
// Never reset the next fixture or finalize a mutable trace until those callbacks have settled.
export function trackOperation(active, callback) {
  const operation = Promise.resolve().then(callback);
  active.add(operation);
  operation.then(() => active.delete(operation), () => active.delete(operation));
  return operation;
}

export async function drainOperations(active, timeoutMs) {
  if (!active.size) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled([...active]).then(() => active.size === 0),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function saveSummary(file, summary) {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function latestModelTree(body) {
  for (const message of [...body.messages].reverse()) {
    if (message.role !== 'tool') continue;
    try {
      const tree = extractObservation(JSON.parse(message.content));
      if (tree) return tree;
    } catch { /* A host error has no usable observation. */ }
  }
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log('node scripts/testbed-eval.mjs --serial emulator-5580 --mode fixture|model --suite generated|legacy --scenes navigation,search --seeds 17,29,43 --repeat 1 --output /tmp/eval.json [--resume]');
    console.log('--split regression|holdout --max-cases 500 --max-model-requests 200 --max-minutes 30 --list-cases --manifest /tmp/cases.json --case-ids <ids> --decision-delay-ms 0 (fixture only)');
    console.log('Model mode: TAPPILOT_EVAL_BASE_URL/MODEL/API_KEY, or Electron desktop/scripts/android-eval.mjs. Dedicated emulator only; no permission grants.');
    return;
  }
  const definitions = JSON.parse(await readFile(path.join(root, 'android/testbed/scenarios.json'), 'utf8'));
  const cases = makeCases(definitions, args);
  if (args.manifest) await writeFile(path.resolve(args.manifest), `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`, { mode: 0o600 });
  if (args.listCases) {
    const diversity = args.suite === 'generated' ? summarizeVariantDiversity(cases.map(entry => entry.scenario)) : undefined;
    const summary = { cases: cases.length, diversity, caseIds: cases.map(value => value.caseId) };
    console.log(JSON.stringify(summary)); return summary;
  }
  if (!/^emulator-\d+$/.test(args.serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  const model = args.mode === 'fixture' ? { baseUrl: 'https://synthetic-model.invalid/v1', model: 'fixture', apiKey: '' }
    : injected.model ?? { baseUrl: process.env.TAPPILOT_EVAL_BASE_URL, model: process.env.TAPPILOT_EVAL_MODEL, apiKey: process.env.TAPPILOT_EVAL_API_KEY ?? '' };
  if (!model.baseUrl || !model.model) fail('MODEL_CONFIG_REQUIRED');
  const { createPhoneClient } = await import(pathToFileURL(path.join(root, 'server/dist/client-tools.js')));
  const { Adb } = await import(pathToFileURL(path.join(root, 'server/dist/adb.js')));
  const { Bridge } = await import(pathToFileURL(path.join(root, 'server/dist/bridge.js')));
  const { runAgent, endpointFor } = await import(pathToFileURL(path.join(root, 'server/dist/runtime/index.js')));
  const { chooseFixtureAction } = await import('./testbed-fixture-policy.mjs');
  endpointFor(model);
  const runId = randomUUID();
  const lease = await acquireDeviceLease({ serial: args.serial, runId });
  const output = args.output && path.resolve(args.output);
  let journal, budget, summary;
  const cancel = new AbortController();
  const onCancel = () => cancel.abort();
  process.once('SIGINT', onCancel); process.once('SIGTERM', onCancel);
  try {
    const identity = { suite: 'android-testbed-v2', config: batchHash({ cases, caseTimeoutMs: args.caseTimeoutMs, decisionDelayMs: args.decisionDelayMs }),
      model: batchHash({ baseUrl: model.baseUrl, model: model.model, mode: args.mode }) };
    if (output) journal = await openBatchJournal({ path: `${output}.jsonl`, identity, resume: args.resume });
    const reports = [...(journal?.completed.values() ?? [])];
    const interruptedAttempts = [...(journal?.attempts ?? [])];
    budget = new BatchBudget({ maxCases: args.maxCases, maxModelRequests: args.maxModelRequests, maxDurationMs: args.maxMinutes * 60000,
      signal: AbortSignal.any([cancel.signal, ...(injected.signal ? [injected.signal] : [])]), initial: journal?.latestBudget ?? reports.at(-1)?.budget,
      beforeModelRequest: snapshot => journal?.checkpoint(snapshot) });
    const adbPath = process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
    const adbCommand = async (command, signal, timeout = 20000) => (await exec(adbPath, ['-s', args.serial, ...command], { signal, timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
    const newClient = async () => {
      const access = new Adb({ executable: adbPath, serial: args.serial, allowEmulator: true });
      await access.select(); return createPhoneClient(new Bridge(access), access);
    };
    const preflight = await newClient();
    try {
      const info = await preflight.execute('get_device_info', {}, budget.signal);
      const bridgeResult = info.result?.bridge;
      if (bridgeResult?.ok === false) fail(safeCode(bridgeResult.error));
      const state = bridgeResult?.result;
      if (!info.ok || !state?.serviceConnected || state.stopped !== false || state.locked !== false) fail('SERVICE_NOT_READY');
      if (state.executor !== 'node-v1') fail('EXECUTOR_UPGRADE_REQUIRED');
    } finally { await preflight.close(); }
    let stopReason;
    for (const entry of cases) {
      if (journal?.completed.has(entry.caseId)) continue;
      try { budget.startCase(); await journal?.checkpoint(budget.snapshot()); } catch (error) { stopReason = safeCode(error); break; }
      const { scenario, repetition, caseId } = entry;
      const caseRunId = randomUUID();
      const oracleIdentity = { runId: caseRunId, scene: scenario.id, seed: scenario.seed, variantId: scenario.variantId };
      let client, latestTree, declaration, result, final, caseError;
      const steps = [], errors = [], oracleSnapshots = [];
      const activeTools = new Set();
      const cleanupCancel = new AbortController();
      const finished = new AbortController();
      const caseDeadline = AbortSignal.timeout(args.caseTimeoutMs);
      const caseSignal = AbortSignal.any([budget.signal, finished.signal, cleanupCancel.signal, caseDeadline]);
      const readOracle = async (signal) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try { return JSON.parse(await adbCommand(['exec-out', 'run-as', fixturePackage, 'cat', definitions.oraclePath], signal, 3000)); }
          catch { if (signal?.aborted || attempt === 1) return undefined; }
        }
      };
      try {
        const reset = ['am', 'start', '-S', '-n', definitions.activity, '--es', 'scene', scenario.id, '--ei', 'seed', scenario.seed, '--es', 'runId', caseRunId];
        if (scenario.variant) reset.push('--es', 'variant', JSON.stringify(scenario.variant));
        // Fixture reset is the sole ADB mutation. All input uses the production executor.
        await adbCommand(['shell', reset.map(quote).join(' ')], caseSignal);
        const resetDeadline = Date.now() + 6000;
        let initial;
        do {
          caseSignal.throwIfAborted(); initial = await readOracle(caseSignal);
          if (initial?.configurationError) fail('FIXTURE_CONFIG_INVALID');
          if (oracleMatchesIdentity(initial, oracleIdentity) && Object.entries(scenario.initial).every(([key, value]) => initial[key] === value)) break;
          await pause(60);
        } while (Date.now() < resetDeadline);
        if (!oracleMatchesIdentity(initial, oracleIdentity) || !Object.entries(scenario.initial).every(([key, value]) => initial[key] === value)) fail('FIXTURE_RESET_FAILED');
        oracleSnapshots.push(initial);
        client = await newClient();
        const foregroundDeadline = Date.now() + 6000;
        let foreground = false;
        do {
          caseSignal.throwIfAborted();
          const current = await client.execute('get_current_app', {}, caseSignal);
          foreground = current.ok === true && current.result?.packageName === fixturePackage;
          if (foreground) break;
          await pause(60);
        } while (Date.now() < foregroundDeadline);
        if (!foreground) fail('FIXTURE_WINDOW_NOT_READY');
        let modelRound = 0;
        const fixtureFetch = async (_url, init) => {
          const tree = latestModelTree(JSON.parse(init.body));
          // Freeze the observation before the delay, reproducing model thinking without an API call.
          if (args.decisionDelayMs) await delay(args.decisionDelayMs, undefined, { signal: init.signal });
          const action = scenario.variant ? chooseVariantAction(scenario, tree) : chooseFixtureAction(scenario.id, tree);
          const name = action ? action.tool ?? 'act_and_observe' : 'finish_evaluation';
          const actionArgs = action ? action.tool ? action.arguments : action : scenario.expectedOutcome === 'unavailable'
            ? { outcome: 'cannot_complete', reason: 'inaccessible_ui' } : { outcome: 'completed', reason: 'goal_reached' };
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: `fixture-${++modelRound}`, type: 'function', function: { name, arguments: JSON.stringify(actionArgs) } }] } }] }));
        };
        const fetch = args.mode === 'fixture' ? fixtureFetch : budget.wrapFetch(injected.modelFetch ?? globalThis.fetch);
        result = await runAgent({ task: scenario.task + modelFinishInstruction, model, modelFetch: fetch,
          tools: [...client.tools, evaluationFinishTool], signal: caseSignal, maxTurns: 40,
          execute: (name, actionArgs, signal) => trackOperation(activeTools, async () => {
            if (name === 'finish_evaluation') {
              declaration = parseFinishDeclaration(actionArgs); finished.abort(new Error('EVALUATION_FINISHED'));
              return { ok: true, result: { recorded: true } };
            }
            signal.throwIfAborted();
            const before = await readOracle(signal);
            signal.throwIfAborted();
            const value = name === 'act_and_observe' && !allowedActions.has(actionArgs.action)
              ? { ok: false, error: { code: 'MANUAL_ACTION_REQUIRED', message: 'This isolated task does not authorize navigation outside the fixture.', retryable: false } }
              : await client.execute(name, actionArgs, signal);
            const after = await readOracle(signal);
            oracleSnapshots.push(before, after);
            steps.push(createStepEvidence({ index: steps.length, name, args: actionArgs, beforeTree: latestTree, response: value,
              beforeOracle: before, afterOracle: after, oracleIdentity, expectedInput: scenario.variant?.labels.input }));
            const observed = extractObservation(value);
            if (observed) latestTree = observed;
            const actualPackage = observed?.packageName ?? value.result?.packageName;
            if (actualPackage && actualPackage !== fixturePackage) fail('FIXTURE_APP_LEFT');
            return value;
          }),
          onEvent: event => { if (typeof event.errorCode === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(event.errorCode)) errors.push(event.errorCode); },
        });
        const runtimeCode = result?.error?.split(':', 1)[0];
        if (/^[A-Z][A-Z_0-9]{0,63}$/.test(runtimeCode ?? '')) errors.push(runtimeCode);
        if (budget.signal.aborted) caseError = safeCode(budget.signal.reason);
        else if (caseDeadline.aborted) caseError = 'CASE_TIMEOUT';
      } catch (error) { caseError = safeCode(error); }
      finally {
        cleanupCancel.abort(new Error('CASE_ENDED'));
        const settled = await drainOperations(activeTools, 5000);
        await client?.close().catch(() => {});
        if (!settled) caseError = 'CASE_CLEANUP_PENDING';
        final = await readOracle();
        oracleSnapshots.push(final);
      }
      const evaluation = evaluateCase({ scenario, runId: caseRunId, actual: final, declaration,
        runtimeStatus: declaration ? 'stopped' : result?.status, steps });
      const report = { caseId, scene: scenario.id, seed: scenario.seed, split: args.split, repetition, mode: args.mode,
        variantId: scenario.variantId ?? null, coverage: scenario.coverage, observedCoverage: [...new Set([...observedCoverage(scenario, oracleSnapshots), ...observedActionCoverage(steps)])], ...evaluation,
        wrongClicks: Number.isSafeInteger(final?.wrongClicks) ? final.wrongClicks : null,
        ...(caseError ? { caseError } : {}), errors: [...new Set(errors)], steps,
        metrics: result?.metrics ?? null, budget: budget.snapshot() };
      if (caseError) report.status = caseError === 'CASE_TIMEOUT' ? 'timeout' : 'environment_failure';
      await journal?.checkpoint(budget.snapshot());
      if (budget.signal.aborted || caseError === 'CASE_CLEANUP_PENDING') {
        report.status = 'interrupted';
        await journal?.appendAttempt(caseId, report);
        interruptedAttempts.push({ caseId, report });
      } else {
        await journal?.append(caseId, report); reports.push(report);
      }
      summary = summarizeReports(reports, cases.length, budget.snapshot(), undefined, interruptedAttempts);
      await saveSummary(output, summary);
      console.log(JSON.stringify({ caseId, status: report.status, wrongClicks: report.wrongClicks,
        modelRequests: report.metrics?.modelRequests ?? 0, totalMs: report.metrics?.totalMs ?? 0,
        ...(caseError ? { caseError } : {}) }));
      if (budget.signal.aborted || terminalEnvironment.has(caseError) || errors.some(code => terminalEnvironment.has(code))) {
        stopReason = caseError ?? errors.find(code => terminalEnvironment.has(code)) ?? safeCode(budget.signal.reason); break;
      }
    }
    summary = summarizeReports(reports, cases.length, budget.snapshot(), stopReason, interruptedAttempts);
    await saveSummary(output, summary);
    console.log(JSON.stringify({ ...summary, reports: undefined, interruptedAttempts: interruptedAttempts.length }));
    if (summary.pendingCases || reports.some(report => !['success', 'correct_refusal'].includes(report.status))) process.exitCode = 1;
    return summary;
  } finally {
    budget?.dispose(); await journal?.close(); await lease.release();
    process.removeListener('SIGINT', onCancel); process.removeListener('SIGTERM', onCancel);
  }
}
