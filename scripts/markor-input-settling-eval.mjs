#!/usr/bin/env node
// Two independent public QuickNote experiments. Measured actions are never replayed.
// All observed UI stays in memory; only fixed-role diagnostic evidence is written.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { observation } from './native-executor-eval.mjs';
import { observedTree, selectTarget } from './real-app-executor.mjs';
import { sanitizedRealAppOracle, sanitizedRealAppStep } from './real-app-model.mjs';
import { createRealAppSession, fail, launchRealApp, safeCode, validateRealAppOptions } from './real-app-support.mjs';

const packageName = 'net.gsantner.markor';
const selectors = {
  quicknote: { contentDescription: 'QuickNote' },
  editor: { resourceId: `${packageName}:id/document__fragment__edit__highlighting_editor`, editable: true },
  save: { resourceId: `${packageName}:id/action_save` },
  search: { resourceId: `${packageName}:id/action_search` },
  query: { resourceId: `${packageName}:id/searchEditText`, editable: true },
  close: { resourceId: `${packageName}:id/closeImageButton` },
  noResults: { resourceId: `${packageName}:id/resultTextView`, text: 'No results' },
};
const noteText = 'TapPilot 时间窗验证';
const queryText = 'TapPilot';
const preparationTexts = ['TapPilot 测试准备甲', 'TapPilot 测试准备乙'];
const queryPreparation = '不存在的合成词';
const decisionDelayMs = 3000;
const finalExpectation = { stage: 'assertions', assertions: [
  { id: 'note_preserved', selector: { ...selectors.editor, text: noteText } },
  { id: 'search_closed', selector: { resourceId: selectors.query.resourceId }, minCount: 0, maxCount: 0 },
  { id: 'editing_mode', selector: { contentDescription: 'View Mode' } },
] };

const matching = (tree, selector) => (tree?.nodes ?? []).filter(node => node?.visible !== false
  && Object.entries(selector).every(([key, value]) => node[key] === value));
const inputVerified = (tree, selector, text) => {
  const nodes = matching(tree, selector);
  return nodes.length === 1 && nodes[0].text === text && nodes[0].showingHintText === false;
};

/** A fixed local test only; never accepts arbitrary notes, queries, apps or tasks. */
export async function runMarkorInputSettling({ client, inspect, onStep = () => {} }) {
  const started = performance.now(), steps = [], phases = [];
  let tree, observedAt, stage = 'initial_read', setupFailure, oracle, oracleFailure;
  let uiReads = 0, oracleReads = 0;
  const call = async (scope, stepId, name, args) => {
    stage = stepId;
    const beforeTree = tree, began = performance.now();
    if (name === 'get_ui_tree' || name === 'wait_for_ui_change') uiReads++;
    let response;
    try { response = await client.call(name, args); }
    catch (error) { response = { ok: false, error: { code: safeCode(error?.code) ?? safeCode(error?.message) ?? 'REAL_APP_TRANSPORT_FAILED' } }; }
    const row = { scope, stage: stepId, ...sanitizedRealAppStep({ index: steps.length, name, args, response,
      beforeTree, packageName, durationMs: performance.now() - began,
      sinceObservationMs: observedAt === undefined ? undefined : began - observedAt }) };
    steps.push(row); onStep(row);
    if (observation(response)) { tree = observedTree(response, packageName); observedAt = performance.now(); }
    return response;
  };
  const requireOk = response => {
    if (response?.ok !== true) fail(safeCode(response?.error?.code) ?? 'REAL_APP_TOOL_FAILED');
  };
  const read = async (scope, stepId) => {
    const response = await call(scope, stepId, 'get_ui_tree', { maxNodes: 500, maxDepth: 40 });
    requireOk(response);
    tree = observedTree(response, packageName);
  };
  const act = async (scope, stepId, action, selector, { text, waitMs = 1500, waitFor } = {}) => {
    const target = selectTarget(tree, 'explicit', selector);
    const response = await call(scope, stepId, 'act_and_observe', { action,
      arguments: { ...target, ...(text === undefined ? {} : { text }) }, waitMs,
      ...(waitFor && tree.observationCapabilities?.actionSelectorWait ? { waitFor } : {}) });
    requireOk(response);
    if (response.result?.action?.accepted !== true) fail('REAL_APP_ACTION_NOT_ACCEPTED');
    tree = observedTree(response, packageName);
    return response;
  };
  const waitForSetup = async (scope, stepId, selector) => {
    try { selectTarget(tree, 'explicit', selector); return; }
    catch (error) { if (error?.message !== 'REAL_APP_TARGET_MISSING') throw error; }
    const response = await call(scope, stepId, 'wait_for_ui_change', {
      sinceRevision: tree.revision, snapshotId: tree.snapshotId, timeoutMs: 5000, selector,
      ...(tree.observationCapabilities?.readinessWait ? { requireUsable: true } : {}),
    });
    requireOk(response);
    tree = observedTree(response, packageName);
    selectTarget(tree, 'explicit', selector);
  };

  // This function intentionally has no get_ui_tree, selector wait or oracle call
  // between input return and the follow-up action. The returned snapshot is kept
  // in memory and used directly after three seconds, even if the UI later changes.
  const measure = async (id, inputSelector, text, nextSelector, completed) => {
    const phaseStart = performance.now(), offset = steps.length;
    const phase = { id, status: 'failed', measuredActionReplays: 0, followupCalls: 0,
      decisionDelayMs, measuredWaitMs: 350, readsDuringDecision: 0, oracleReadsDuringDecision: 0 };
    let errorCode;
    try {
      const current = matching(tree, inputSelector);
      if (current.length !== 1 || current[0].text === text) fail('MEASURED_INPUT_ALREADY_SATISFIED');
      await act(id, 'measured_input', 'input_text', inputSelector, { text, waitMs: 350 });
      phase.inputVerifiedFromFirstReturn = inputVerified(tree, inputSelector, text);
      if (!phase.inputVerifiedFromFirstReturn) fail('REAL_APP_INPUT_NOT_VERIFIED');
      const retainedTree = tree;
      const target = selectTarget(retainedTree, 'explicit', nextSelector);
      const readsBeforeDelay = uiReads, oraclesBeforeDelay = oracleReads;
      const delayStart = performance.now();
      await delay(decisionDelayMs);
      phase.actualDecisionDelayMs = Math.round(performance.now() - delayStart);
      phase.readsDuringDecision = uiReads - readsBeforeDelay;
      phase.oracleReadsDuringDecision = oracleReads - oraclesBeforeDelay;
      if (tree !== retainedTree || phase.readsDuringDecision || phase.oracleReadsDuringDecision) fail('MEASURED_OBSERVATION_REPLACED');
      phase.followupCalls++;
      const response = await call(id, 'measured_followup', 'act_and_observe', {
        action: 'tap_element', arguments: target, waitMs: 350,
      });
      requireOk(response);
      if (response.result?.action?.accepted !== true) fail('REAL_APP_ACTION_NOT_ACCEPTED');
      tree = observedTree(response, packageName);
      phase.expectedTransitionFromFirstReturn = completed(tree);
      if (!phase.expectedTransitionFromFirstReturn) fail('REAL_APP_TRANSITION_UNVERIFIED');
      phase.status = 'passed';
    } catch (error) { errorCode = safeCode(error?.message) ?? 'MEASURED_PHASE_FAILED'; }
    const measuredSteps = steps.slice(offset);
    phase.toolFailures = measuredSteps.filter(step => !step.ok).length;
    phase.actionCalls = measuredSteps.filter(step => step.tool === 'act_and_observe').length;
    phase.durationMs = Math.round(performance.now() - phaseStart);
    if (errorCode) phase.errorCode = errorCode;
    phases.push(phase);
    return phase;
  };

  try {
    await read('setup', 'initial_read');
    await waitForSetup('setup', 'wait_quicknote_tab', selectors.quicknote);
    // Always use the observed QuickNote tab, never a file-list note or deep link.
    await act('setup', 'open_quicknote_tab', 'tap_element', selectors.quicknote, { waitFor: selectors.editor });
    if (!matching(tree, selectors.editor).length && matching(tree, { contentDescription: 'Edit Mode' }).length === 1) {
      await act('setup', 'enter_edit_mode', 'tap_element', { contentDescription: 'Edit Mode' }, { waitFor: selectors.editor });
    }
    await waitForSetup('setup', 'wait_note_editor', selectors.editor);
    if (matching(tree, selectors.query).length) {
      await act('setup', 'close_restored_search', 'tap_element', selectors.close);
    }
    const editors = matching(tree, selectors.editor);
    if (editors.length !== 1) fail('REAL_APP_TARGET_AMBIGUOUS');
    const preparation = preparationTexts.find(text => text !== editors[0].text);
    await act('setup', 'establish_saved_baseline', 'input_text', selectors.editor, { text: preparation });
    if (!inputVerified(tree, selectors.editor, preparation)) fail('BASELINE_INPUT_NOT_VERIFIED');
    await waitForSetup('setup', 'wait_save_enabled', { ...selectors.save, enabled: true });
    await act('setup', 'save_baseline', 'tap_element', selectors.save);
    const saves = matching(tree, selectors.save);
    if (saves.length !== 1 || saves[0].enabled !== false) fail('BASELINE_NOT_SAVED');

    const first = await measure('note_input_to_search', selectors.editor, noteText, selectors.search,
      current => matching(current, selectors.query).length === 1 && matching(current, selectors.close).length === 1
        && inputVerified(current, selectors.editor, noteText));

    // Separate experiment setup, explicitly outside the measured phase. A refused
    // first phase stays failed; reopening search here is not task progress/retry.
    await read('query_phase_setup', 'independent_query_phase_read');
    if (!inputVerified(tree, selectors.editor, noteText)) fail('SECOND_PHASE_NOTE_PRECONDITION_FAILED');
    if (!matching(tree, selectors.query).length) {
      if (first.status === 'passed') fail('SEARCH_DISAPPEARED_AFTER_FIRST_PHASE');
      await act('query_phase_setup', 'open_search_for_independent_phase', 'tap_element', selectors.search,
        { waitFor: selectors.query });
    }
    await waitForSetup('query_phase_setup', 'wait_query_editor', selectors.query);
    await act('query_phase_setup', 'establish_different_query', 'input_text', selectors.query,
      { text: queryPreparation, waitFor: selectors.noResults });
    if (!inputVerified(tree, selectors.query, queryPreparation)) fail('QUERY_BASELINE_NOT_VERIFIED');
    if (matching(tree, selectors.noResults).length !== 1) fail('QUERY_BASELINE_RESULT_UNVERIFIED');
    await measure('query_input_to_close', selectors.query, queryText, selectors.close,
      current => matching(current, selectors.query).length === 0 && inputVerified(current, selectors.editor, noteText));
  } catch (error) { setupFailure = { stage, errorCode: safeCode(error?.message) ?? 'EXPERIMENT_SETUP_FAILED' }; }

  // The sole UIAutomator observation runs after both experiments. It cannot turn
  // a refused measured action into a pass and never triggers cleanup/replay.
  try {
    oracleReads++;
    oracle = sanitizedRealAppOracle(await inspect({ ...finalExpectation, timeoutMs: 2500 }), finalExpectation);
    if (oracle?.verdict !== 'verified') oracleFailure = 'REAL_APP_FINAL_UNVERIFIED';
  } catch (error) { oracleFailure = safeCode(error?.message) ?? 'REAL_APP_ORACLE_FAILED'; }
  const passed = !setupFailure && !oracleFailure && phases.length === 2 && phases.every(phase => phase.status === 'passed');
  return { schemaVersion: 1, suite: 'markor-input-settling', status: passed ? 'passed' : 'failed',
    modelCalls: 0, measuredActionReplays: 0, decisionDelayMs, uiReads, oracleReads,
    durationMs: Math.round(performance.now() - started),
    measuredToolFailures: phases.reduce((sum, phase) => sum + phase.toolFailures, 0),
    independentPhaseSetupActions: steps.filter(step => step.scope === 'query_phase_setup' && step.tool === 'act_and_observe').length,
    phases, steps, ...(setupFailure ? { setupFailure } : {}), ...(oracleFailure ? { oracleFailure } : {}), oracle: oracle ?? null };
}

export async function main(argv = process.argv.slice(2)) {
  const args = { entry: 'desktop' };
  const names = { '--serial': 'serial', '--entry': 'entry', '--output': 'output' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') args.help = true;
    else if (names[argv[index]] && argv[index + 1]) args[names[argv[index]]] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (args.help) {
    console.log('node scripts/markor-input-settling-eval.mjs --serial emulator-5580 --entry desktop|mcp --output /tmp/markor-input-settling.json');
    console.log('Overwrites only the isolated emulator QuickNote with fixed synthetic text. Two separate input(waitMs350) → 3s without reads → follow-up experiments. No measured mutation replay.');
    return;
  }
  if (typeof args.output !== 'string' || !args.output) fail('OUTPUT_REQUIRED');
  validateRealAppOptions({ ...args, packageName });
  const session = await createRealAppSession({ ...args, packageName });
  try {
    await launchRealApp(session, `${packageName}/.activity.MainActivity`);
    const report = { ...await runMarkorInputSettling({ client: session.client,
      inspect: options => session.inspect(options), onStep: step => console.log(JSON.stringify({ type: 'step', ...step })) }), entry: args.entry };
    await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (report.status !== 'passed') process.exitCode = 1;
    return report;
  } finally { await session.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error?.message) ?? 'MARKOR_INPUT_SETTLING_FAILED'); process.exitCode = 1; });
}
