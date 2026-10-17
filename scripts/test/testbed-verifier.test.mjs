import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCase, createStepEvidence, parseFinishDeclaration, sanitizeOracle, observedCoverage, observedActionCoverage } from '../testbed-verifier.mjs';

const scenario = { id: 'search', seed: 17, expected: { completed: true, wrongClicks: 0, receivedInput: 'expected' } };
const identity = { runId: 'synthetic-run', scene: 'search', seed: 17 };
const initial = { schemaVersion: 1, ...identity, page: 'search', completed: false, wrongClicks: 0, clickCount: 0, receivedInput: 'none', lastTarget: 'none' };
const completed = { ...initial, completed: true, receivedInput: 'expected', clickCount: 2 };
const declaredComplete = { outcome: 'completed', reason: 'goal_reached' };
const declined = { outcome: 'cannot_complete', reason: 'inaccessible_ui' };
const judge = (actual, declaration, more = {}) => evaluateCase({ scenario, runId: identity.runId, actual, declaration, runtimeStatus: 'completed', ...more });

test('independent business state alone proves success; declarations and runtime completed do not', () => {
  assert.equal(judge(completed).status, 'success');
  assert.equal(judge(initial).status, 'unknown_report');
  assert.equal(judge(initial, declaredComplete).status, 'false_completion');
  assert.equal(judge(initial, declined).status, 'task_failed');
  assert.equal(judge({ ...completed, runId: 'old-run' }, declaredComplete).status, 'oracle_invalid');
  assert.equal(judge({ ...completed, wrongClicks: 1 }, declaredComplete).status, 'false_completion');
});

test('capability refusal requires explicit declaration, unavailable case and independent absence of side effects', () => {
  const unavailable = { ...scenario, expectedOutcome: 'unavailable' };
  assert.equal(judge(initial, declined, { scenario: unavailable }).status, 'correct_refusal');
  assert.equal(judge(initial, undefined, { scenario: unavailable }).status, 'unknown_report');
  assert.equal(judge(initial, declaredComplete, { scenario: unavailable }).status, 'false_completion');
  assert.equal(judge({ ...initial, clickCount: 1 }, declined, { scenario: unavailable }).status, 'task_failed');
  assert.equal(judge({ ...initial, receivedInput: 'other' }, declined, { scenario: unavailable }).status, 'task_failed');
  assert.equal(judge(initial, declined, { scenario: unavailable, steps: [{ dispatchState: 'sent' }] }).status, 'task_failed');
});

test('variant identity and nonempty known expectations are required before judging completion', () => {
  assert.equal(judge(completed, declaredComplete, { scenario: { ...scenario, variantId: 'new' } }).status, 'oracle_invalid');
  assert.equal(judge({ ...completed, variantId: 'new' }, declaredComplete, { scenario: { ...scenario, variantId: 'new' } }).status, 'success');
  assert.equal(judge({ ...completed, configurationError: true }, declaredComplete).status, 'oracle_invalid');
  assert.equal(judge(completed, declaredComplete, { scenario: { ...scenario, expected: {} } }).status, 'oracle_invalid');
  assert.equal(judge(completed, declaredComplete, { scenario: { ...scenario, expected: { privateText: 'secret' } } }).status, 'oracle_invalid');
});

test('finish protocol has fixed reason categories and rejects arbitrary text and contradictory claims', () => {
  assert.deepEqual(parseFinishDeclaration(declaredComplete), declaredComplete);
  for (const value of [{ ...declaredComplete, text: 'private' }, { outcome: 'completed', reason: 'tool_failure' },
    { outcome: 'cannot_complete', reason: 'goal_reached' }, { outcome: 'cannot_complete', reason: 'raw model answer' }, null]) {
    assert.throws(() => parseFinishDeclaration(value), { message: 'INVALID_FINISH_DECLARATION' });
  }
});

const tree = { snapshotId: 'private-snapshot', sessionId: 'private-session', packageName: 'dev.tappilot.testbed', revision: 1, truncated: false,
  nodes: [{ nodeId: 'private-node', resourceId: 'dev.tappilot.testbed:id/search_result', text: 'private-label', contentDescription: 'private-desc' }] };
const refusal = { ok: false, error: { code: 'TARGET_CHANGED', message: 'private-error', details: { dispatchState: 'not_sent', reason: 'PAGE_CONTEXT_CHANGED', text: 'private-detail' } },
  meta: { nativeExecutorRefusal: true }, observation: { ...tree, snapshotId: 'new-private-snapshot', revision: 2 } };
const step = (response = refusal, afterOracle = initial, overrides = {}) => createStepEvidence({ index: 1, name: 'act_and_observe',
  args: { action: 'tap_element', arguments: { snapshotId: tree.snapshotId, nodeId: 'private-node', text: 'private-input' } },
  beforeTree: tree, response, beforeOracle: initial, afterOracle, oracleIdentity: identity, ...overrides });

test('trace contains fixed categories and identity digests without raw UI, model, input, handles or error text', () => {
  const evidence = step();
  assert.deepEqual(evidence.selected, { key: 'search_result', role: 'target', oracleTarget: 'search_result' });
  assert.equal(evidence.dispatchState, 'not_sent');
  assert.equal(evidence.snapshotChanged, true);
  assert.equal(evidence.uiChanged, null); // A revision is an event counter, not proof of changed content.
  assert.equal(evidence.revisionChanged, true);
  assert.equal(evidence.beforeUi.complete, true);
  assert.equal(evidence.oracle.afterFresh, true);
  assert.equal(JSON.stringify(evidence).includes('private-'), false);
  assert.deepEqual(sanitizeOracle({ ...initial, page: 'private-page', password: 'private-password', lastTarget: 'private-target' }), {
    wrongClicks: 0, clickCount: 0, completed: false, receivedInput: 'none',
  });
  assert.equal(step({ ...refusal, error: { code: 'PRIVATE_SECRET', details: { reason: 'PRIVATE_SECRET' } } }).error, 'UNKNOWN');
});

test('dispatch evidence requires the validated refusal marker; stale or foreign oracle is never trusted', () => {
  assert.equal(step({ ...refusal, meta: {} }).dispatchState, 'unknown');
  const evidence = step(refusal, { ...initial, runId: 'other-run', wrongClicks: 5 });
  assert.equal(evidence.oracle.after, null);
  assert.equal(evidence.oracle.wrongClickDelta, null);
  assert.deepEqual(judge(initial, declined, { steps: [evidence] }).attributionCandidates, [{ category: 'environment', evidence: 'oracle_identity_unverified', step: 1 }]);
});

test('label allowance traces retain only bounded counts and fixed result categories, including rejected requests', () => {
  const args = { action: 'input_text', arguments: { nodeId: 'private-node', allowedLabelChanges: ['private-status-node'] } };
  const action = { executor: 'node-v1', dispatchState: 'sent', accepted: true, contextVerification: 'explicit_label_changes', allowedLabelChangesCount: 1 };
  const response = { ok: true, result: { action, observation: tree } };
  const evidence = step(response, initial, { args });
  assert.equal(evidence.requestedLabelAllowanceCount, 1);
  assert.equal(evidence.contextVerification, 'explicit_label_changes');
  assert.equal(evidence.allowedLabelChangesCount, 1);
  assert.equal(JSON.stringify(evidence).includes('private-'), false);
  const refused = step(refusal, initial, { args });
  assert.equal(refused.requestedLabelAllowanceCount, 1);
  assert.equal(refused.contextVerification, null);
  assert.equal(refused.allowedLabelChangesCount, null);
  const defaultResult = step({ ...response, result: { action: { ...action, contextVerification: 'default_context', allowedLabelChangesCount: 0 } } });
  assert.equal(defaultResult.requestedLabelAllowanceCount, 0);
  assert.equal(defaultResult.contextVerification, 'default_context');
  assert.equal(defaultResult.allowedLabelChangesCount, 0);
  for (const invalid of [null, 'private-status-node', [null], [''], ['private-node', 'private-node'], Array.from({ length: 9 }, (_, i) => `private-${i}`)]) {
    assert.equal(step(response, initial, { args: { ...args, arguments: { ...args.arguments, allowedLabelChanges: invalid } } }).requestedLabelAllowanceCount, null);
  }
  for (const invalid of [undefined, null, -1, 9, 0.5, 'private-count']) {
    const sanitized = step({ ...response, result: { action: { ...action, contextVerification: 'private-mode', allowedLabelChangesCount: invalid } } });
    assert.equal(sanitized.contextVerification, null);
    assert.equal(sanitized.allowedLabelChangesCount, null);
    assert.equal(JSON.stringify(sanitized).includes('private-'), false);
  }
});

test('attribution uses target and actual business effect; a failing model run alone remains unknown', () => {
  assert.deepEqual(judge(initial, declined).attributionCandidates, [{ category: 'unknown', evidence: 'insufficient_independent_evidence', step: null }]);
  const actual = { ...initial, clickCount: 1, wrongClicks: 1, lastTarget: 'distractor_1' };
  const response = { ok: true, result: { action: { executor: 'node-v1', dispatchState: 'sent', accepted: true }, observation: tree } };
  assert.deepEqual(judge(actual, declined, { steps: [step(response, actual)] }).attributionCandidates,
    [{ category: 'executor', evidence: 'effect_target_differs_from_requested_target', step: 1 }]);
  const wrongTree = { ...tree, nodes: [{ ...tree.nodes[0], resourceId: 'dev.tappilot.testbed:id/variant_distractor' }] };
  assert.deepEqual(judge(actual, declined, { steps: [step(response, actual, { beforeTree: wrongTree })] }).attributionCandidates,
    [{ category: 'model_selection', evidence: 'selected_known_distractor_and_wrong_effect', step: 1 }]);
  const notSent = step(refusal, { ...initial, clickCount: 1 });
  assert.deepEqual(judge(initial, declined, { steps: [notSent] }).attributionCandidates,
    [{ category: 'executor', evidence: 'refused_action_has_click_effect', step: 1 }]);
});

test('verified text can be the wrong requested text; do not blame execution for a model input error', () => {
  const actual = { ...initial, receivedInput: 'other' };
  const response = { ok: true, result: { action: { executor: 'node-v1', dispatchState: 'sent', accepted: true, textVerified: true }, observation: tree } };
  const args = { action: 'input_text', arguments: { nodeId: 'private-node', text: 'private-input' } };
  assert.deepEqual(judge(actual, declined, { steps: [step(response, actual, { args })] }).attributionCandidates,
    [{ category: 'unknown', evidence: 'insufficient_independent_evidence', step: null }]);
  assert.deepEqual(judge(actual, declined, { steps: [step(response, actual, { args, expectedInput: 'different-expected' })] }).attributionCandidates,
    [{ category: 'model_selection', evidence: 'requested_input_differs_from_task', step: 1 }]);
  const evidence = step(response, actual, { args, expectedInput: 'private-input' });
  assert.equal(JSON.stringify(evidence).includes('private-input'), false);
  assert.deepEqual(judge(actual, declined, { steps: [evidence] }).attributionCandidates,
    [{ category: 'executor', evidence: 'verified_input_contradicts_oracle', step: 1 }]);
});

test('search results retain fixed intermediate page evidence and actual transitions are reported', () => {
  assert.deepEqual(sanitizeOracle({ page: 'results' }), { page: 'results' });
  assert.deepEqual(observedCoverage(scenario, [initial, { ...initial, page: 'results' }, completed]),
    ['page_transition_observed', 'search_results_observed', 'expected_input_received', 'task_effect_observed']);
});

test('configured refresh, replacement and reorder tags cannot manufacture observed coverage', () => {
  for (const refreshMode of ['peer_text', 'replace', 'reorder']) {
    const refreshing = { id: 'async_list', seed: 29, variantId: 'variant', variant: { refreshMode, refreshCount: 12 }, coverage: [`async_${refreshMode}`] };
    const start = { ...initial, scene: 'async_list', seed: 29, variantId: 'variant', page: 'list', refreshCount: 0 };
    assert.deepEqual(observedCoverage(refreshing, [start, { ...start }]), []);
    assert.deepEqual(observedCoverage(refreshing, [start, { ...start, refreshCount: 1 }]), ['refresh_observed', 'refresh_progress_observed']);
    assert.deepEqual(observedCoverage(refreshing, [start, { ...start, refreshCount: 2 }]),
      ['refresh_observed', 'repeated_refresh_observed', 'refresh_progress_observed']);
  }
});

test('coverage rejects foreign lifecycle evidence and never treats regressing counters as a refresh sequence', () => {
  const refreshing = { id: 'async_list', seed: 29, variantId: 'variant' };
  const start = { ...initial, scene: 'async_list', seed: 29, variantId: 'variant', refreshCount: 0 };
  for (const change of [{ runId: 'another-run' }, { variantId: 'other' }, { seed: 30 }, { configurationError: true }]) {
    assert.deepEqual(observedCoverage(refreshing, [start, { ...start, refreshCount: 2, ...change }]), []);
  }
  assert.deepEqual(observedCoverage(refreshing, [start, { ...start, refreshCount: 3 }, { ...start, refreshCount: 1 }]), []);
  assert.deepEqual(observedCoverage(refreshing, [undefined, { ...start, refreshCount: 2 }]), []);
});

test('oracle-backed business changes are separate from configured modal, recipient and keyboard conditions', () => {
  const base = { ...initial, scene: 'ime', page: 'conversation_a', focus: 'none', recipient: 'synthetic_a', overlayDismissed: false, refreshCount: 0 };
  const changed = { ...base, focus: 'draft', recipient: 'synthetic_b', overlayDismissed: true, refreshCount: 2, wrongClicks: 1 };
  assert.deepEqual(observedCoverage({ id: 'ime', seed: 17 }, [base, changed]), [
    'input_focus_observed', 'overlay_dismissal_observed', 'recipient_change_observed', 'wrong_click_observed',
    'refresh_observed', 'repeated_refresh_observed', 'refresh_progress_observed', 'refreshing_form_text_observed',
  ]);
});

test('actual effect counters preserve evidence and distinguish callback ticks from changed UI objects', () => {
  const scenario = { id: 'async_list', seed: 29, variantId: 'variant', variant: { refreshMode: 'replace', refreshCount: 300 } };
  const start = { ...initial, scene: 'async_list', seed: 29, variantId: 'variant', page: 'list',
    refreshCount: 0, orderChangeCount: 0, replacementCount: 0, peerTextChangeCount: 0 };
  const tickOnly = { ...start, refreshCount: 1 };
  assert.deepEqual(sanitizeOracle({ orderChangeCount: 2, replacementCount: 1, peerTextChangeCount: 3, arbitraryCounter: 'private' }),
    { orderChangeCount: 2, replacementCount: 1, peerTextChangeCount: 3 });
  assert.deepEqual(observedCoverage(scenario, [start, tickOnly]), ['refresh_observed', 'refresh_progress_observed']);
  const effects = { ...tickOnly, orderChangeCount: 1, replacementCount: 1, peerTextChangeCount: 1 };
  assert.deepEqual(observedCoverage(scenario, [start, tickOnly, effects]), [
    'refresh_observed', 'refresh_progress_observed', 'list_order_change_observed', 'node_replacement_observed', 'peer_text_change_observed',
  ]);
});

test('action overlap requires a sent action and fresh oracle deltas, not earlier refresh counts', () => {
  const base = { action: 'tap_element', dispatchState: 'sent', oracle: { beforeFresh: true, afterFresh: true,
    before: { refreshCount: 20, orderChangeCount: 3, replacementCount: 2, peerTextChangeCount: 5 },
    after: { refreshCount: 20, orderChangeCount: 3, replacementCount: 2, peerTextChangeCount: 5 } } };
  assert.deepEqual(observedActionCoverage([base]), []);
  const during = { ...base, oracle: { ...base.oracle, after: { refreshCount: 21, orderChangeCount: 4, replacementCount: 3, peerTextChangeCount: 6 } } };
  assert.deepEqual(observedActionCoverage([during, during]), ['refresh_during_action_observed', 'list_order_change_during_action_observed',
    'node_replacement_during_action_observed', 'peer_text_change_during_action_observed']);
  for (const override of [{ action: null }, { action: 'get_ui_tree' }, { dispatchState: 'not_sent' }, { dispatchState: 'unknown' },
    { oracle: { ...during.oracle, afterFresh: false } }, { oracle: { ...during.oracle, before: null } },
    { oracle: { ...during.oracle, after: { ...during.oracle.after, refreshCount: 19 } } }]) {
    assert.deepEqual(observedActionCoverage([{ ...during, ...override }]), []);
  }
  assert.deepEqual(observedActionCoverage([{ ...during, oracle: { ...during.oracle, before: {} } }]), []);
});

test('effect counters survive createStepEvidence without retaining private oracle fields', () => {
  const before = { ...initial, refreshCount: 1, replacementCount: 0 };
  const after = { ...initial, refreshCount: 2, replacementCount: 1, privateText: 'private-oracle-text' };
  const response = { ok: true, result: { action: { executor: 'node-v1', dispatchState: 'sent', accepted: true }, observation: tree } };
  const evidence = step(response, after, { beforeOracle: before });
  assert.equal(evidence.oracle.after.replacementCount, 1);
  assert.equal(JSON.stringify(evidence).includes('private-oracle-text'), false);
  assert.deepEqual(observedActionCoverage([evidence]), ['refresh_during_action_observed', 'node_replacement_during_action_observed']);
});

test('snapshot-linked evidence distinguishes refreshed-before-dispatch from changes during an action', () => {
  const ui = { snapshot: 'digest-snapshot', session: null, fixtureApp: true };
  const origin = { tool: 'get_ui_tree', afterUi: ui, oracle: { afterFresh: true, after: { refreshCount: 2, replacementCount: 1, orderChangeCount: 0 } } };
  const action = { tool: 'act_and_observe', action: 'tap_element', dispatchState: 'sent', beforeUi: ui, requestedSnapshot: ui.snapshot,
    oracle: { beforeFresh: true, afterFresh: true, before: { refreshCount: 5, replacementCount: 4, orderChangeCount: 2 },
      after: { refreshCount: 5, replacementCount: 4, orderChangeCount: 2 } } };
  assert.deepEqual(observedActionCoverage([origin, action]), [
    'refresh_since_observation_observed', 'revalidated_after_refresh',
    'list_order_change_since_observation_observed', 'revalidated_after_list_order_change',
    'node_replacement_since_observation_observed', 'revalidated_after_node_replacement',
  ]);
  assert.deepEqual(observedActionCoverage([origin, { ...action, dispatchState: 'not_sent' }]), [
    'refresh_since_observation_observed', 'observed_refusal_after_refresh',
    'list_order_change_since_observation_observed', 'observed_refusal_after_list_order_change',
    'node_replacement_since_observation_observed', 'observed_refusal_after_node_replacement',
  ]);
});

test('snapshot association fails closed on mismatches, missing or regressing counters, or unknown dispatch', () => {
  const ui = { snapshot: 'digest-snapshot', session: 'digest-session', fixtureApp: true };
  const origin = { tool: 'get_ui_tree', afterUi: ui, oracle: { afterFresh: true, after: { refreshCount: 2 } } };
  const action = { tool: 'act_and_observe', action: 'input_text', dispatchState: 'sent', beforeUi: ui, requestedSnapshot: ui.snapshot,
    oracle: { beforeFresh: true, before: { refreshCount: 3 } } };
  for (const override of [{ beforeUi: { ...ui, snapshot: 'different' } }, { beforeUi: { ...ui, session: 'different' } },
    { requestedSnapshot: 'different-request' }, { requestedSnapshot: null }, { dispatchState: 'unknown' }, { action: null },
    { oracle: { beforeFresh: false, before: { refreshCount: 3 } } }, { oracle: { beforeFresh: true, before: {} } },
    { oracle: { beforeFresh: true, before: { refreshCount: 2 } } }, { oracle: { beforeFresh: true, before: { refreshCount: 1 } } }]) {
    assert.deepEqual(observedActionCoverage([origin, { ...action, ...override }]), []);
  }
  assert.deepEqual(observedActionCoverage([{ ...origin, oracle: { ...origin.oracle, afterFresh: false } }, action]), []);
  assert.deepEqual(observedActionCoverage([action, origin]), []);
  assert.deepEqual(observedActionCoverage([origin, { tool: 'find_element', afterUi: null }, action]), []);
});

test('legacy snapshot evidence can be recomputed, and repeated snapshot reads use the latest oracle boundary', () => {
  const ui = { snapshot: 'digest-snapshot', session: null, fixtureApp: true };
  const origin = { tool: 'get_ui_tree', afterUi: ui, oracle: { afterFresh: true, after: { refreshCount: 2 } } };
  const action = { tool: 'act_and_observe', action: 'tap_element', dispatchState: 'sent', beforeUi: ui,
    oracle: { beforeFresh: true, before: { refreshCount: 3 } } };
  assert.deepEqual(observedActionCoverage([origin, action]), ['refresh_since_observation_observed', 'revalidated_after_refresh']);
  const newer = { ...origin, oracle: { afterFresh: true, after: { refreshCount: 3 } } };
  assert.deepEqual(observedActionCoverage([origin, newer, action]), []);
  const evidence = step();
  assert.equal(evidence.requestedSnapshot, evidence.beforeUi.snapshot);
  assert.equal(JSON.stringify(evidence).includes('private-snapshot'), false);
});
