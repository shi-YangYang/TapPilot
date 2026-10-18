#!/usr/bin/env node
// Deterministic real-app lane: observed semantic targets, one dispatch per step, independent readback.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observation } from './native-executor-eval.mjs';
import { createRealAppSession, fail, launchRealApp, safeCode, validateLaunchComponent, validateRealAppOptions } from './real-app-support.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = node => node.visible !== false && node.enabled !== false && node.password !== true;
const labels = node => [node.text, node.contentDescription].filter(value => typeof value === 'string').map(value => value.trim());

/** Observed PDD 8.27 login screen, not a generic occurrence of a login word. */
export function isPinduoduoLoginGate(tree) {
  if (tree?.packageName !== 'com.xunmeng.pinduoduo' || !Array.isArray(tree.nodes)) return false;
  const current = new Set(tree.nodes.filter(visible).flatMap(labels));
  return current.has('微信登录') && current.has('其他方式登录') &&
    ['手机号', 'QQ', '数字身份'].some(label => current.has(label));
}

export function observedTree(value, packageName) {
  const tree = observation(value);
  if (!tree || tree.executor !== 'node-v1' || !Array.isArray(tree.nodes)) fail('REAL_APP_UI_UNAVAILABLE');
  if (tree.packageName !== packageName) fail('REAL_APP_SCOPE_CHANGED');
  if (isPinduoduoLoginGate(tree)) fail('REAL_APP_MANUAL_STEP_REQUIRED');
  return tree;
}

export function selectTarget(tree, role, selector) {
  if (!Array.isArray(tree?.nodes) || typeof tree.snapshotId !== 'string') fail('REAL_APP_UI_UNAVAILABLE');
  const matches = tree.nodes.filter(node => visible(node) && (selector ?
    Object.entries(selector).every(([key, value]) => node[key] === value ||
      (value === false && ['editable', 'clickable', 'scrollable'].includes(key) && node[key] === undefined)) :
    role === 'editor' ? node.editable === true :
      role === 'submit' ? node.editable !== true && labels(node).some(text => text === '搜索') :
        node.editable === true || labels(node).some(text => /^(搜索|搜索商品|搜索好货|搜商品|搜索你想要的商品)$/.test(text))));
  if (matches.length === 0) fail('REAL_APP_TARGET_MISSING');
  if (matches.length !== 1) fail('REAL_APP_TARGET_AMBIGUOUS');
  const node = matches[0];
  if (typeof node.nodeId !== 'string') fail('REAL_APP_UI_UNAVAILABLE');
  return { snapshotId: tree.snapshotId, nodeId: node.nodeId };
}

function sanitizedContextChange(value) {
  if (!value || !['target', 'ancestor', 'target_descendant', 'peer_item', 'outside_target', 'mixed', 'unknown'].includes(value.region) ||
    !['content', 'state', 'structure', 'geometry', 'mixed', 'unknown'].includes(value.kind) ||
    !Number.isInteger(value.changedNodes) || value.changedNodes < 0 || value.changedNodes > 500 ||
    typeof value.targetMatched !== 'boolean' || typeof value.actionTargetMatched !== 'boolean') return;
  return { region: value.region, kind: value.kind, changedNodes: value.changedNodes,
    targetMatched: value.targetMatched, actionTargetMatched: value.actionTargetMatched };
}

export function safeStep(stage, action, response, durationMs, sinceObservationMs, beforeTree) {
  const execution = response?.result?.execution;
  const contextChange = sanitizedContextChange(response?.error?.details?.contextChange);
  const after = observation(response);
  return { stage, action, durationMs, ok: response?.ok === true,
    accepted: response?.result?.action?.accepted === true,
    dispatch: ['sent', 'not_sent', 'unknown'].includes(execution?.dispatch) ? execution.dispatch :
      response?.error?.details?.dispatchState === 'not_sent' ? 'not_sent' : 'unknown',
    verification: ['verified', 'unverified'].includes(execution?.verification) ? execution.verification : null,
    effect: ['changed', 'unchanged', 'unknown'].includes(execution?.effect) ? execution.effect : null,
    ...(safeCode(response?.error?.code) ? { errorCode: response.error.code } : {}),
    ...(safeCode(response?.error?.details?.reason) ? { reason: response.error.details.reason } : {}),
    ...(contextChange ? { contextChange } : {}),
    ...(Number.isFinite(sinceObservationMs) && sinceObservationMs >= 0 ? { sinceObservationMs: Math.round(sinceObservationMs) } : {}),
    ...(Array.isArray(after?.nodes) ? { nodeCount: after.nodes.length } : {}),
    ...(['usable', 'limited', 'unavailable'].includes(after?.quality?.status) ? { quality: after.quality.status } : {}),
    ...(Number.isInteger(beforeTree?.windowId) && Number.isInteger(after?.windowId) ? { windowChanged: beforeTree.windowId !== after.windowId } : {}),
  };
}

/** No exception path replays a mutation. Failures remain failures for localization. */
export async function runDeterministicSearch({ client, inspect, packageName = 'com.xunmeng.pinduoduo', query = '机械键盘',
  decisionDelayMs = 0, entrySelector, submitSelector, onStep = () => {} }) {
  const started = performance.now();
  const steps = [];
  let stage = 'initial_read', failure, oracle, tree, observedAt;
  const call = async (action, args, mutating = false) => {
    if (mutating && decisionDelayMs) await pause(decisionDelayMs);
    const began = performance.now();
    const response = await client.call(action, args);
    const report = safeStep(stage, action === 'act_and_observe' ? args.action : action, response, Math.round(performance.now() - began),
      observedAt == null ? undefined : began - observedAt, tree);
    if (observation(response)) observedAt = performance.now();
    steps.push(report); onStep(report);
    if (response?.ok !== true) fail(safeCode(response?.error?.code) ?? 'REAL_APP_TOOL_FAILED');
    return response;
  };
  const act = async (action, args, waitFor) => {
    const response = await call('act_and_observe', { action, arguments: args, waitMs: 1500,
      ...(tree?.observationCapabilities?.actionSelectorWait && waitFor ? { waitFor } : {}) }, true);
    if (response.result?.action?.accepted !== true) fail('REAL_APP_ACTION_NOT_ACCEPTED');
    tree = observedTree(response, packageName);
  };
  try {
    tree = observedTree(await call('get_ui_tree', { maxNodes: 500, maxDepth: 40 }), packageName);
    if (!tree.nodes.some(node => visible(node) && node.editable === true)) {
      try { selectTarget(tree, 'entry', entrySelector); }
      catch (error) {
        if (error?.message !== 'REAL_APP_TARGET_MISSING') throw error;
        // Cold launch can expose the correct package before its search control.
        // Wait for one explicit condition; ambiguity is never solved by waiting or tapping.
        stage = 'wait_initial_search_entry';
        tree = observedTree(await call('wait_for_ui_change', { sinceRevision: tree.revision, snapshotId: tree.snapshotId,
          timeoutMs: 5000, selector: entrySelector ?? { contentDescription: '搜索' },
          ...(tree.observationCapabilities?.readinessWait ? { requireUsable: true } : {}) }), packageName);
      }
    }
    if (!tree.nodes.some(node => visible(node) && node.editable === true)) {
      stage = 'open_search';
      await act('tap_element', selectTarget(tree, 'entry', entrySelector), { editable: true });
      if (!tree.nodes.some(node => visible(node) && node.editable === true)) {
        // A bounded read-only wait may finish loading. It never replays the tap.
        stage = 'wait_search_editor';
        tree = observedTree(await call('wait_for_ui_change', { sinceRevision: tree.revision, snapshotId: tree.snapshotId,
          timeoutMs: 2500, selector: { editable: true }, ...(tree.observationCapabilities?.readinessWait ? { requireUsable: true } : {}) }), packageName);
      }
    }
    stage = 'input_query';
    await act('input_text', { ...selectTarget(tree, 'editor'), text: query });
    // Input acceptance alone is insufficient. Require exactly one current matching editor.
    const editors = tree.nodes.filter(node => visible(node) && node.editable === true);
    if (editors.length !== 1 || editors[0].text !== query || editors[0].showingHintText !== false) fail('REAL_APP_INPUT_NOT_VERIFIED');
    stage = 'submit_search';
    await act('tap_element', selectTarget(tree, 'submit', submitSelector));
    stage = 'independent_verification';
    oracle = await inspect({ query, stage: 'search_results', timeoutMs: 5000 });
    if (oracle.verdict !== 'verified') fail(oracle.verdict === 'blocked' ? 'REAL_APP_MANUAL_STEP_REQUIRED' : 'REAL_APP_RESULT_UNVERIFIED');
  } catch (error) {
    failure = safeCode(error?.message) ?? 'REAL_APP_EXECUTION_FAILED';
    // Even refused/uncertain cases receive read-only independent evidence. The
    // oracle cannot turn a failed step into a pass and never retries the action.
    if (!oracle) {
      try { oracle = await inspect({ query, stage: stage === 'input_query' ? 'search_input' : 'search_results', timeoutMs: 0 }); }
      catch { /* Preserve the original execution failure, not raw instrumentation output. */ }
    }
  }
  return { schemaVersion: 1, lane: 'deterministic', packageName, modelCalls: 0,
    status: failure ? 'failed' : 'passed', stage, decisionDelayMs, durationMs: Math.round(performance.now() - started),
    actionCalls: steps.filter(step => ['tap_element', 'input_text'].includes(step.action)).length,
    mutationReplays: 0, steps, ...(failure ? { failure } : {}), ...(oracle ? { oracle } : {}) };
}

function argumentsOf(argv) {
  const args = { entry: 'desktop', query: '机械键盘', decisionDelayMs: 0 };
  const keys = { '--serial': 'serial', '--entry': 'entry', '--query': 'query', '--output': 'output',
    '--decision-delay-ms': 'decisionDelayMs', '--entry-text': 'entryText', '--entry-description': 'entryDescription',
    '--entry-resource': 'entryResource', '--submit-text': 'submitText', '--launch-component': 'launchComponent' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') args.help = true;
    else if (keys[argv[index]] && argv[index + 1]) args[keys[argv[index]]] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  args.decisionDelayMs = Number(args.decisionDelayMs);
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsOf(argv);
  if (args.help) {
    console.log('node scripts/real-app-executor.mjs --serial emulator-5580 [--entry desktop|mcp] [--query 机械键盘] [--decision-delay-ms 3000] [--entry-text <observed exact label>] [--launch-component com.xunmeng.pinduoduo/.ui.activity.MainFrameActivity] [--output /tmp/real-app.json]');
    console.log('Requires an already open Pinduoduo public home/search page, authorized debug receiver, and the testbed/androidTest oracle APKs. Does not accept consent, log in, buy, change permissions, or replay actions.');
    return;
  }
  validateRealAppOptions(args);
  if (args.launchComponent) validateLaunchComponent(args.launchComponent);
  const session = await createRealAppSession(args);
  try {
    if (args.launchComponent) await launchRealApp(session, args.launchComponent);
    const entrySelector = { ...(args.entryText ? { text: args.entryText } : {}), ...(args.entryDescription ? { contentDescription: args.entryDescription } : {}),
      ...(args.entryResource ? { resourceId: args.entryResource } : {}) };
    const report = { ...await runDeterministicSearch({ ...args, packageName: session.packageName, client: session.client,
      inspect: options => session.inspect(options),
      ...(Object.keys(entrySelector).length ? { entrySelector } : {}),
      ...(args.submitText ? { submitSelector: { text: args.submitText, editable: false } } : {}),
      onStep: step => console.log(JSON.stringify({ type: 'step', ...step })) }), environment: session.environment,
      setup: args.launchComponent ? 'force_stop_launch' : 'existing_page' };
    if (args.output) await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (report.status !== 'passed') process.exitCode = 1;
    return report;
  } finally { await session.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'REAL_APP_EXECUTION_FAILED'); process.exitCode = 1; });
}
