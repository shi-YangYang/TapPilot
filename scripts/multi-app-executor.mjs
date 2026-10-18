#!/usr/bin/env node
// Production executor calls with an independent, read-only oracle after each action.
// Only launch/setup uses ADB; no coordinate input and no mutation retries.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { observation } from './native-executor-eval.mjs';
import { observedTree, safeStep, selectTarget } from './real-app-executor.mjs';
import { createRealAppSession, fail, launchRealApp, safeCode, validateRealAppAssertions, validateRealAppOptions } from './real-app-support.mjs';
import { realAppCases, resolveRealAppCase } from './real-app-cases.mjs';

const actions = new Set(['tap_element', 'input_text', 'scroll', 'press_key']);

export function validateMultiAppCase(spec) {
  if (!spec || !/^[a-z][a-z0-9-]{0,63}$/.test(spec.id ?? '') || !Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 20) fail('INVALID_REAL_APP_CASE');
  validateRealAppOptions({ serial: 'emulator-5580', packageName: spec.packageName });
  validateRealAppAssertions(spec.oracle?.assertions);
  const ids = new Set();
  for (const step of spec.steps) {
    if (!step || !/^[a-z][a-z0-9_]{0,63}$/.test(step.id ?? '') || ids.has(step.id) || !actions.has(step.action)) fail('INVALID_REAL_APP_CASE');
    ids.add(step.id);
    if (step.action === 'press_key') {
      if (step.key !== 'back' || step.selector) fail('INVALID_REAL_APP_CASE');
    } else validateRealAppAssertions([{ id: 'target', selector: step.selector }]);
    if (step.action === 'input_text' && (typeof step.text !== 'string' || !/^[\p{L}\p{N} ·-]{1,80}$/u.test(step.text) || /\d{6,}/.test(step.text))) fail('PUBLIC_TEXT_REQUIRED');
    if (step.action === 'scroll' && !['forward', 'backward', 'up', 'down', 'left', 'right'].includes(step.direction)) fail('INVALID_REAL_APP_CASE');
    validateRealAppAssertions(step.assertions);
    if (step.waitFor) validateRealAppAssertions([{ id: 'wait_target', selector: step.waitFor }]);
    if (step.requireNewEvidence !== undefined && typeof step.requireNewEvidence !== 'boolean') fail('INVALID_REAL_APP_CASE');
  }
  return spec;
}

function matches(node, selector) {
  return node.visible !== false && Object.entries(selector).every(([key, expected]) =>
    node[key] === expected || (expected === false && ['editable', 'clickable', 'scrollable', 'checked', 'selected'].includes(key) && node[key] === undefined));
}

/** A fixed test workflow, not an app adapter: production still locates, guards and executes. */
export async function runMultiAppCase({ client, inspect, spec, decisionDelayMs = 0, onStep = () => {} }) {
  validateMultiAppCase(spec);
  validateRealAppOptions({ serial: 'emulator-5580', packageName: spec.packageName, decisionDelayMs });
  const started = performance.now(), steps = [], assertions = [];
  let tree, observedAt, failure, oracle, stage = 'initial_read';
  const call = async (name, args, mutating = false) => {
    if (mutating && decisionDelayMs) await delay(decisionDelayMs);
    const began = performance.now();
    const response = await client.call(name, args);
    const step = safeStep(stage, name === 'act_and_observe' ? args.action : name, response,
      Math.round(performance.now() - began), observedAt == null ? undefined : began - observedAt, tree);
    steps.push(step); onStep(step);
    if (observation(response)) observedAt = performance.now();
    if (response?.ok !== true) fail(safeCode(response?.error?.code) ?? 'REAL_APP_TOOL_FAILED');
    return response;
  };
  const read = async () => { tree = observedTree(await call('get_ui_tree', { maxNodes: 500, maxDepth: 40 }), spec.packageName); };
  try {
    await read();
    for (let index = 0; index < spec.steps.length; index++) {
      const step = spec.steps[index];
      // Instrumentation is an independent observer with its own lifecycle. A fresh
      // production read after it avoids manufacturing stale references by the test.
      if (index > 0) { stage = `${step.id}_read`; await read(); }
      stage = step.id;
      let target;
      if (step.selector) {
        try { target = selectTarget(tree, 'explicit', step.selector); }
        catch (error) {
          if (error?.message !== 'REAL_APP_TARGET_MISSING') throw error;
          stage = `${step.id}_wait`;
          tree = observedTree(await call('wait_for_ui_change', { sinceRevision: tree.revision, snapshotId: tree.snapshotId,
            timeoutMs: 5000, selector: step.selector,
            ...(tree.observationCapabilities?.readinessWait ? { requireUsable: true } : {}) }), spec.packageName);
          target = selectTarget(tree, 'explicit', step.selector);
          stage = step.id;
        }
      }
      if (step.requireNewEvidence && step.assertions.every(assertion => {
        const count = tree.nodes.filter(node => matches(node, assertion.selector)).length;
        return count >= (assertion.minCount ?? 1) && count <= (assertion.maxCount ?? 1);
      })) fail('REAL_APP_TRANSITION_ALREADY_SATISFIED');
      const args = step.action === 'press_key' ? { key: step.key } : { ...target,
        ...(step.action === 'input_text' ? { text: step.text } : {}),
        ...(step.action === 'scroll' ? { direction: step.direction } : {}) };
      const response = await call('act_and_observe', { action: step.action, arguments: args, waitMs: 1500,
        ...(step.waitFor && tree.observationCapabilities?.actionSelectorWait ? { waitFor: step.waitFor } : {}) }, true);
      if (response.result?.action?.accepted !== true) fail('REAL_APP_ACTION_NOT_ACCEPTED');
      tree = observedTree(response, spec.packageName);
      if (step.action === 'input_text' && !tree.nodes.some(node => matches(node, step.selector) &&
        node.editable === true && node.text === step.text && node.showingHintText === false)) fail('REAL_APP_INPUT_NOT_VERIFIED');
      stage = `${step.id}_oracle`;
      const evidence = await inspect({ stage: 'assertions', assertions: step.assertions, timeoutMs: 5000 });
      assertions.push({ stage: step.id, ...evidence });
      if (evidence.verdict !== 'verified') fail('REAL_APP_RESULT_UNVERIFIED');
    }
    // Final task proof is a fresh sample, never a cached earlier per-step success.
    stage = 'independent_final_verification';
    oracle = await inspect({ ...spec.oracle, timeoutMs: 2500 });
    if (oracle.verdict !== 'verified') fail('REAL_APP_RESULT_UNVERIFIED');
  } catch (error) {
    failure = safeCode(error?.message) ?? 'REAL_APP_EXECUTION_FAILED';
    if (!oracle) {
      try { oracle = await inspect({ ...spec.oracle, timeoutMs: 0 }); } catch { /* Preserve the original error without raw UI/transport output. */ }
    }
  }
  return { schemaVersion: 1, lane: 'multi_app_deterministic', caseId: spec.id, packageName: spec.packageName,
    status: failure ? 'failed' : 'passed', stage, decisionDelayMs, modelCalls: 0, mutationReplays: 0,
    durationMs: Math.round(performance.now() - started), actionCalls: steps.filter(step => actions.has(step.action)).length,
    steps, assertions, ...(failure ? { failure } : {}), ...(oracle ? { oracle } : {}) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = { entry: 'desktop', decisionDelayMs: 0 };
  const keys = { '--serial': 'serial', '--entry': 'entry', '--case': 'caseId', '--decision-delay-ms': 'decisionDelayMs', '--output': 'output' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') args.help = true;
    else if (keys[argv[index]] && argv[index + 1]) args[keys[argv[index]]] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (args.help) {
    console.log('node scripts/multi-app-executor.mjs --serial emulator-5580 --case CASE [--entry desktop|mcp] [--decision-delay-ms 3000] [--output /tmp/report.json]');
    console.log(`Observed cases: ${realAppCases.map(spec => spec.id).join(', ')}. Requires completed manual onboarding. No permissions, login, purchases or action replay.`);
    return;
  }
  const spec = validateMultiAppCase(resolveRealAppCase(args.caseId));
  args.decisionDelayMs = Number(args.decisionDelayMs);
  const session = await createRealAppSession({ ...args, packageName: spec.packageName });
  try {
    await launchRealApp(session, spec.launchComponent);
    const report = { ...await runMultiAppCase({ ...args, spec, client: session.client, inspect: options => session.inspect(options),
      onStep: step => console.log(JSON.stringify({ type: 'step', ...step })) }), entry: args.entry,
      setup: 'force_stop_launch', environment: session.environment };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (report.status !== 'passed') process.exitCode = 1;
    return report;
  } finally { await session.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'MULTI_APP_EXECUTION_FAILED'); process.exitCode = 1; });
}
