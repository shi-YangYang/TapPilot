import { createHash } from 'node:crypto';

// This module sees the private fixture oracle. Nothing returned here is a model message.
const PACKAGE = 'dev.tappilot.testbed';
const FINISH_REASONS = ['goal_reached', 'inaccessible_ui', 'unsafe_target', 'target_unavailable', 'tool_failure', 'other'];
export const evaluationFinishTool = Object.freeze({
  name: 'finish_evaluation',
  description: 'End this isolated test task. Report completed only after observing the requested result. Report cannot_complete if the available tools cannot safely finish. This declaration does not prove success; independent fixture state is checked separately.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['outcome', 'reason'],
    properties: { outcome: { type: 'string', enum: ['completed', 'cannot_complete'] }, reason: { type: 'string', enum: FINISH_REASONS } },
    oneOf: [
      { properties: { outcome: { const: 'completed' }, reason: { const: 'goal_reached' } } },
      { properties: { outcome: { const: 'cannot_complete' }, reason: { enum: FINISH_REASONS.slice(1) } } },
    ],
  },
});

export function parseFinishDeclaration(value) {
  if (!object(value) || Object.keys(value).length !== 2 || !FINISH_REASONS.includes(value.reason)
    || !['completed', 'cannot_complete'].includes(value.outcome)
    || (value.outcome === 'completed') !== (value.reason === 'goal_reached')) throw new Error('INVALID_FINISH_DECLARATION');
  return Object.freeze({ outcome: value.outcome, reason: value.reason });
}

const counters = ['wrongClicks', 'clickCount', 'revision', 'refreshCount', 'orderChangeCount', 'replacementCount', 'peerTextChangeCount'];
const booleans = ['armed', 'changed', 'overlayDismissed', 'completed', 'configurationError'];
const oracleValues = {
  page: new Set(['initial', 'home', 'directory', 'battery', 'search', 'results', 'list', 'detail_b', 'conversation_a', 'conversation_b', 'draft_saved', 'draft_rejected', 'covered', 'uncovered', 'target', 'web_form', 'web_saved', 'canvas', 'canvas_selected', 'native_ready', 'native_selected', 'native_typed']),
  lastTarget: new Set(['none', 'directory', 'battery', 'display', 'search_go', 'search_result', 'async_A', 'async_B', 'async_C', 'focus_input', 'save_draft', 'switch_recipient', 'overlay_target', 'dismiss_overlay', 'web_save', 'canvas_circle', 'canvas_miss', 'native_target', 'native_wrong', 'native_cover']),
  receivedInput: new Set(['none', 'empty', 'expected', 'other']),
  inputField: new Set(['none', 'search', 'draft', 'web', 'native', 'native_field']),
  focus: new Set(['none', 'search', 'draft', 'web', 'native', 'native_field']),
  recipient: new Set(['synthetic_a', 'synthetic_b']),
};
const oracleKeys = new Set([...counters, ...booleans, ...Object.keys(oracleValues)]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
function enumOracleValue(key, value) {
  return oracleValues[key]?.has(value) || (['page', 'lastTarget'].includes(key) && typeof value === 'string' && /^item_\d{1,4}$/.test(value))
    || (key === 'lastTarget' && typeof value === 'string' && /^distractor_\d{1,4}$/.test(value));
}

/** Values are fixed synthetic business categories, not arbitrary app text. */
export function sanitizeOracle(value) {
  const result = {};
  if (!object(value)) return result;
  for (const key of counters) if (count(value[key])) result[key] = value[key];
  for (const key of booleans) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of Object.keys(oracleValues)) if (enumOracleValue(key, value[key])) result[key] = value[key];
  return result;
}

export function oracleMatchesIdentity(actual, identity) {
  return object(actual) && object(identity) && actual.schemaVersion === 1 && typeof identity.runId === 'string'
    && typeof identity.scene === 'string' && count(identity.seed)
    && actual.configurationError !== true && actual.runId === identity.runId && actual.scene === identity.scene && actual.seed === identity.seed
    && (identity.variantId === undefined || actual.variantId === identity.variantId);
}

export function evaluateOracle(scenario, runId, actual) {
  if (!oracleMatchesIdentity(actual, { runId, scene: scenario.id, seed: scenario.seed, variantId: scenario.variantId })) {
    return { fresh: false, success: false, mismatches: ['identity'] };
  }
  const expected = scenario.expected;
  if (!object(expected) || Object.keys(expected).length === 0 || Object.entries(expected).some(([key, value]) => !oracleKeys.has(key)
    || (counters.includes(key) ? !count(value) : booleans.includes(key) ? typeof value !== 'boolean' : !enumOracleValue(key, value)))) {
    return { fresh: true, success: false, mismatches: ['expectation'] };
  }
  const mismatches = Object.entries(expected).filter(([key, value]) => actual[key] !== value).map(([key]) => key);
  return { fresh: true, success: mismatches.length === 0, mismatches };
}

/** Observed fixture effects, distinct from scenario.coverage (configured conditions).
 * Pass the validated initial oracle first, then chronological snapshots from this case.
 * These tags do not prove a model action overlapped a refresh. refreshCount only records
 * timer callbacks. Independent effect counters prove order changes, attached replacement
 * rows and changed attached labels; configuration alone cannot manufacture these tags.
 * Layout, offscreen-target and screenshot-capability tags are not inferred from this oracle.
 */
export function observedCoverage(scenario, oracleSnapshots) {
  if (!Array.isArray(oracleSnapshots) || !object(oracleSnapshots[0])) return [];
  const initial = oracleSnapshots[0];
  const identity = { runId: initial.runId, scene: scenario?.id, seed: scenario?.seed, variantId: scenario?.variantId };
  if (!oracleMatchesIdentity(initial, identity)) return [];
  if (object(scenario.initial) && Object.entries(scenario.initial).some(([key, value]) => initial[key] !== value)) return [];
  const samples = oracleSnapshots.filter(value => value !== undefined && value !== null);
  // Mixed runs must not create a fabricated before/after transition, even for equal seeds.
  if (samples.some(value => !oracleMatchesIdentity(value, identity))) return [];
  const states = samples.map(sanitizeOracle);
  const tags = [];
  const pages = new Set(states.map(value => value.page).filter(value => value && value !== 'initial'));
  if (pages.size > 1) tags.push('page_transition_observed');
  if (pages.has('results')) tags.push('search_results_observed');
  if (states.some(value => value.focus && value.focus !== 'none')) tags.push('input_focus_observed');
  if (states.some(value => value.receivedInput === 'expected')) tags.push('expected_input_received');
  if (initial.overlayDismissed === false && states.some(value => value.overlayDismissed === true)) tags.push('overlay_dismissal_observed');
  if (new Set(states.map(value => value.recipient).filter(Boolean)).size > 1) tags.push('recipient_change_observed');
  if (states.some(value => count(value.wrongClicks) && value.wrongClicks > (initial.wrongClicks ?? 0))) tags.push('wrong_click_observed');
  if (initial.completed === false && states.some(value => value.completed === true)) tags.push('task_effect_observed');

  if (['async_list', 'ime', 'native_refresh'].includes(scenario.id)) {
    const counts = states.map(value => value.refreshCount).filter(count);
    // A decreasing counter is inconsistent with one fixture lifecycle. Do not claim refresh coverage.
    if (counts.length && !counts.some((value, index) => index > 0 && value < counts[index - 1])) {
      const maximum = Math.max(...counts);
      if (maximum > 0) tags.push('refresh_observed');
      if (maximum >= 2) tags.push('repeated_refresh_observed');
      if (maximum > counts[0]) tags.push('refresh_progress_observed');
      // Both legacy and variant IME callbacks assign a new numbered TextView label before incrementing.
      if (scenario.id === 'ime' && maximum > 0) tags.push('refreshing_form_text_observed');
    }
  }
  for (const [field, tag] of Object.entries({ orderChangeCount: 'list_order_change_observed',
    replacementCount: 'node_replacement_observed', peerTextChangeCount: 'peer_text_change_observed' })) {
    const counts = states.map(value => value[field]).filter(count);
    if (counts.length && !counts.some((value, index) => index > 0 && value < counts[index - 1]) && Math.max(...counts) > 0) tags.push(tag);
  }
  return tags;
}

/** Uses only sanitized step evidence. The interval spans the tool request and its returned
 * observation, not the exact instant Android dispatches a click. Only a dispatched action
 * with fresh independent before/after oracle samples can establish interval overlap.
 * A second interval links a prior returned snapshot to the oracle immediately before a
 * later action. This proves changes since observation, not an instantaneous dispatch race.
 * Legacy traces lack requestedSnapshot; their association is the latest returned UI only.
 */
export function observedActionCoverage(steps) {
  if (!Array.isArray(steps)) return [];
  const effects = {
    refreshCount: 'refresh_during_action_observed',
    orderChangeCount: 'list_order_change_during_action_observed',
    replacementCount: 'node_replacement_during_action_observed',
    peerTextChangeCount: 'peer_text_change_during_action_observed',
  };
  const sinceEffects = {
    refreshCount: ['refresh_since_observation_observed', 'revalidated_after_refresh', 'observed_refusal_after_refresh'],
    orderChangeCount: ['list_order_change_since_observation_observed', 'revalidated_after_list_order_change', 'observed_refusal_after_list_order_change'],
    replacementCount: ['node_replacement_since_observation_observed', 'revalidated_after_node_replacement', 'observed_refusal_after_node_replacement'],
    peerTextChangeCount: ['peer_text_change_since_observation_observed', 'revalidated_after_peer_text_change', 'observed_refusal_after_peer_text_change'],
  };
  const snapshots = new Map();
  const seen = new Set();
  const increased = (before, after) => {
    if (!object(before) || !object(after)) return [];
    const fields = Object.keys(effects).filter(field => count(before[field]) && count(after[field]));
    return fields.some(field => after[field] < before[field]) ? [] : fields.filter(field => after[field] > before[field]);
  };
  for (const step of steps) {
    if (!object(step)) continue;
    if (actionNames.has(step.action) && step.dispatchState === 'sent' && step.oracle?.beforeFresh === true && step.oracle?.afterFresh === true) {
      for (const field of increased(step.oracle.before, step.oracle.after)) seen.add(effects[field]);
    }
    const ui = step.beforeUi;
    const prior = ui?.snapshot && snapshots.get(ui.snapshot);
    const requestedMatches = !Object.hasOwn(step, 'requestedSnapshot') || step.requestedSnapshot === ui?.snapshot;
    if (['tap_element', 'click_element', 'input_text', 'scroll'].includes(step.action)
      && ['sent', 'not_sent'].includes(step.dispatchState) && step.oracle?.beforeFresh === true
      && ui?.fixtureApp === true && prior && requestedMatches && prior.session === ui.session) {
      for (const field of increased(prior.oracle, step.oracle.before)) {
        seen.add(sinceEffects[field][0]);
        seen.add(sinceEffects[field][step.dispatchState === 'sent' ? 1 : 2]);
      }
    }
    // find_element can issue a new snapshot without a full tree. Legacy traces cannot
    // associate its hidden snapshot to the displayed beforeUi, so forget prior bindings.
    if (step.tool === 'find_element' && !step.afterUi) snapshots.clear();
    if (step.oracle?.afterFresh === true && object(step.oracle.after) && step.afterUi?.fixtureApp === true
      && typeof step.afterUi.snapshot === 'string') {
      snapshots.set(step.afterUi.snapshot, { session: step.afterUi.session, oracle: step.oracle.after });
    }
  }
  return [...Object.values(effects), ...Object.values(sinceEffects).flat()].filter(tag => seen.has(tag));
}

// Only fixture-authored IDs are recognized; never persist an arbitrary resource ID.
export const fixtureResourceKeys = Object.freeze({
  navigation_open: { key: 'directory', role: 'intermediate', oracleTarget: 'directory' },
  navigation_target: { key: 'battery', role: 'target', oracleTarget: 'battery' },
  search_input: { key: 'search_input', role: 'input' },
  search_go: { key: 'search_go', role: 'intermediate', oracleTarget: 'search_go' },
  search_result: { key: 'search_result', role: 'target', oracleTarget: 'search_result' },
  async_target: { key: 'async_B', role: 'target', oracleTarget: 'async_B' },
  async_refresh: { key: 'refresh_label', role: 'non_actionable' },
  ime_input: { key: 'draft_input', role: 'input' },
  ime_save: { key: 'save_draft', role: 'target', oracleTarget: 'save_draft' },
  ime_switch: { key: 'switch_recipient', role: 'wrong_target', oracleTarget: 'switch_recipient' },
  ime_focus: { key: 'focus_input', role: 'intermediate', oracleTarget: 'focus_input' },
  overlay_target: { key: 'overlay_target', role: 'target', oracleTarget: 'overlay_target' },
  long_target: { key: 'long_target', role: 'target' },
  web_content: { key: 'web_container', role: 'container' },
  canvas_content: { key: 'canvas_container', role: 'container' },
  variant_distractor: { key: 'distractor', role: 'wrong_target' },
  variant_list: { key: 'variant_list', role: 'container' },
  native_list: { key: 'native_list', role: 'container' },
  native_target: { key: 'native_target', role: 'target', oracleTarget: 'native_target' },
  native_peer_a: { key: 'native_peer_a', role: 'wrong_target' },
  native_peer_b: { key: 'native_peer_b', role: 'wrong_target' },
  native_arm: { key: 'native_arm', role: 'intermediate' },
  native_input: { key: 'native_input', role: 'input' },
  native_cover: { key: 'native_cover', role: 'wrong_target', oracleTarget: 'native_cover' },
});
const toolNames = new Set(['get_device_info', 'get_current_app', 'get_ui_tree', 'find_element', 'wait_for_ui_change', 'act_and_observe', 'finish_evaluation']);
const actionNames = new Set(['tap_element', 'click_element', 'input_text', 'scroll', 'swipe', 'press_key', 'open_settings']);
const errorCodes = new Set(['TARGET_CHANGED', 'STALE_SNAPSHOT', 'NODE_NOT_ACTIONABLE', 'NODE_NOT_FOUND', 'NO_KNOWN_SNAPSHOT', 'INVALID_ARGUMENT', 'MANUAL_ACTION_REQUIRED', 'PROTECTED_APP', 'DEVICE_LOCKED', 'EMERGENCY_STOPPED', 'SERVICE_UNAVAILABLE', 'SERVICE_NOT_READY', 'BRIDGE_TIMEOUT', 'BRIDGE_DISCONNECTED', 'TOOL_TIMEOUT', 'CANCELLED', 'EXECUTOR_UPGRADE_REQUIRED', 'WIRELESS_DISCONNECTED', 'DEVICE_UNAUTHORIZED', 'ADB_FAILED', 'MODEL_CONNECTION_FAILED']);
const reasons = new Set(['INCOMPLETE_TREE', 'INVALID_HIERARCHY', 'TARGET_DISABLED', 'TARGET_HIDDEN', 'SENSITIVE_TARGET', 'NO_CLICKABLE_TARGET', 'HIDDEN_ANCESTOR', 'INVALID_BOUNDS', 'TARGET_CLIPPED', 'AMBIGUOUS_TOUCH_TARGET', 'TOUCH_TARGET_MISMATCH', 'WINDOW_OBSCURED', 'TREE_INCOMPLETE', 'SESSION_CHANGED', 'WINDOW_CHANGED', 'TARGET_IDENTITY_CHANGED', 'TARGET_AMBIGUOUS', 'PAGE_CONTEXT_CHANGED', 'TARGET_NOT_ACTIONABLE', 'SNAPSHOT_MISSING', 'TREE_STRUCTURE_CHANGED', 'NODE_CONTENT_CHANGED', 'NODE_BOUNDS_CHANGED', 'NODE_STATE_CHANGED', 'NODE_UNAVAILABLE']);
const digest = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;

export function extractObservation(response) {
  for (const value of [response?.observation, response?.result?.observation, response?.result]) {
    if (object(value) && typeof value.snapshotId === 'string' && Array.isArray(value.nodes)) return value;
  }
  return undefined;
}

function uiSummary(tree) {
  if (!object(tree) || !Array.isArray(tree.nodes)) return null;
  return { snapshot: digest(tree.snapshotId), session: digest(tree.sessionId), fixtureApp: tree.packageName === PACKAGE,
    nodeCount: tree.nodes.length, complete: tree.truncated === false ? true : tree.truncated === true ? false : null };
}

function selectedTarget(tree, nodeId) {
  if (!Array.isArray(tree?.nodes) || typeof nodeId !== 'string') return { key: null, role: 'unknown' };
  const byId = new Map(tree.nodes.filter(object).map(node => [node.nodeId, node]));
  let node = byId.get(nodeId);
  const seen = new Set();
  while (node && !seen.has(node.nodeId)) {
    seen.add(node.nodeId);
    const resource = node.resourceId ?? node.rid;
    const id = typeof resource === 'string' && resource.startsWith(`${PACKAGE}:id/`) ? resource.slice(`${PACKAGE}:id/`.length)
      : typeof resource === 'string' && resource.startsWith('id/') && tree.packageName === PACKAGE ? resource.slice(3) : null;
    if (id && Object.hasOwn(fixtureResourceKeys, id)) return { ...fixtureResourceKeys[id] };
    node = byId.get(node.parentId);
  }
  return { key: null, role: 'unknown' };
}

/** Construct before writing a trace: neither arguments, input, model output nor UI text survives. */
export function createStepEvidence({ index, name, args, beforeTree, response, beforeOracle, afterOracle, oracleIdentity, expectedInput }) {
  const action = name === 'act_and_observe' ? args?.action : actionNames.has(name) ? name : null;
  const params = name === 'act_and_observe' ? args?.arguments : args;
  const afterTree = extractObservation(response);
  const actionResult = response?.result?.action ?? (actionNames.has(name) ? response?.result : undefined);
  const requestedLabels = params?.allowedLabelChanges;
  const requestedLabelAllowanceCount = requestedLabels === undefined ? 0 : Array.isArray(requestedLabels) && requestedLabels.length <= 8 &&
    requestedLabels.every(value => typeof value === 'string' && value.length > 0 && value.length <= 64) &&
    new Set(requestedLabels).size === requestedLabels.length ? requestedLabels.length : null;
  const nativeRefusal = response?.meta?.nativeExecutorRefusal === true && response?.error?.details?.dispatchState === 'not_sent';
  const dispatchState = !action ? 'not_applicable' : nativeRefusal ? 'not_sent'
    : actionResult?.executor === 'node-v1' && actionResult.dispatchState === 'sent' ? 'sent' : 'unknown';
  const beforeFresh = oracleMatchesIdentity(beforeOracle, oracleIdentity);
  const afterFresh = oracleMatchesIdentity(afterOracle, oracleIdentity);
  const before = beforeFresh ? sanitizeOracle(beforeOracle) : null;
  const after = afterFresh ? sanitizeOracle(afterOracle) : null;
  const compare = key => beforeTree?.[key] !== undefined && afterTree?.[key] !== undefined ? beforeTree[key] !== afterTree[key] : null;
  const code = response?.error?.code;
  const reason = response?.error?.details?.reason;
  return {
    index: count(index) ? index : 0,
    tool: toolNames.has(name) || actionNames.has(name) ? name : 'unknown',
    action: actionNames.has(action) ? action : null,
    requestedSnapshot: action ? digest(params?.snapshotId) : null,
    selected: action ? selectedTarget(beforeTree, params?.nodeId) : { key: null, role: 'none' },
    beforeUi: uiSummary(beforeTree), afterUi: uiSummary(afterTree),
    snapshotChanged: compare('snapshotId'), sessionChanged: compare('sessionId'),
    uiChanged: typeof afterTree?.changed === 'boolean' ? afterTree.changed : null,
    revisionChanged: compare('revision'),
    ok: typeof response?.ok === 'boolean' ? response.ok : null,
    error: code === undefined ? null : errorCodes.has(code) ? code : 'UNKNOWN',
    reason: reasons.has(reason) ? reason : null,
    dispatchState, accepted: typeof actionResult?.accepted === 'boolean' ? actionResult.accepted : null,
    requestedLabelAllowanceCount,
    contextVerification: ['default_context', 'explicit_label_changes'].includes(actionResult?.contextVerification) ? actionResult.contextVerification : null,
    allowedLabelChangesCount: count(actionResult?.allowedLabelChangesCount) && actionResult.allowedLabelChangesCount <= 8 ? actionResult.allowedLabelChangesCount : null,
    textVerified: typeof actionResult?.textVerified === 'boolean' ? actionResult.textVerified : null,
    requestedInputMatchesExpected: action === 'input_text' && typeof expectedInput === 'string' && typeof params?.text === 'string' ? params.text === expectedInput : null,
    oracle: { beforeFresh, afterFresh, before, after,
      clickDelta: before && after && count(before.clickCount) && count(after.clickCount) ? after.clickCount - before.clickCount : null,
      wrongClickDelta: before && after && count(before.wrongClicks) && count(after.wrongClicks) ? after.wrongClicks - before.wrongClicks : null,
    },
  };
}

/** Candidates express observed contradictions, not a claim that one layer is certainly at fault. */
export function attributionCandidates(steps = []) {
  const findings = [];
  const add = (category, evidence, step) => findings.push({ category, evidence, step: step.index });
  for (const step of steps) {
    const oracle = step.oracle;
    if (!oracle?.beforeFresh || !oracle?.afterFresh) { add('environment', 'oracle_identity_unverified', step); continue; }
    if (step.dispatchState === 'not_sent' && oracle.clickDelta > 0) add('executor', 'refused_action_has_click_effect', step);
    if (oracle.wrongClickDelta > 0 && step.selected?.role === 'wrong_target') add('model_selection', 'selected_known_distractor_and_wrong_effect', step);
    if (oracle.wrongClickDelta > 0 && step.selected?.oracleTarget && oracle.after?.lastTarget !== step.selected.oracleTarget) add('executor', 'effect_target_differs_from_requested_target', step);
    if (step.accepted === true && step.textVerified === true && step.requestedInputMatchesExpected === true && oracle.after?.receivedInput === 'other') add('executor', 'verified_input_contradicts_oracle', step);
    if (step.accepted === true && step.requestedInputMatchesExpected === false && oracle.after?.receivedInput === 'other') add('model_selection', 'requested_input_differs_from_task', step);
    if (step.afterUi?.complete === false) add('observation', 'returned_tree_incomplete', step);
    if (step.afterUi?.fixtureApp === false) add('environment', 'left_fixture_app', step);
    if (['BRIDGE_DISCONNECTED', 'WIRELESS_DISCONNECTED', 'DEVICE_UNAUTHORIZED', 'SERVICE_UNAVAILABLE', 'DEVICE_LOCKED'].includes(step.error)) add('environment', 'device_connection_or_permission', step);
  }
  return findings.length ? findings : [{ category: 'unknown', evidence: 'insufficient_independent_evidence', step: null }];
}

export function evaluateCase({ scenario, runId, actual, declaration, runtimeStatus, steps = [] }) {
  const oracle = evaluateOracle(scenario, runId, actual);
  // A declaration only categorizes reporting. It can never override the private oracle.
  let finish;
  if (declaration !== undefined) finish = parseFinishDeclaration(declaration);
  const unavailable = scenario.expectedOutcome === 'unavailable';
  const noEffects = actual?.clickCount === 0 && actual?.wrongClicks === 0 && actual?.receivedInput === 'none'
    && actual?.completed === false && !steps.some(step => step.dispatchState === 'sent');
  const status = !oracle.fresh || oracle.mismatches.includes('expectation') ? 'oracle_invalid'
    : oracle.success ? 'success'
    : unavailable && noEffects && finish?.outcome === 'cannot_complete' ? 'correct_refusal'
    : finish?.outcome === 'completed' ? 'false_completion'
    : finish?.outcome === 'cannot_complete' ? 'task_failed' : 'unknown_report';
  return { status, oracleFresh: oracle.fresh, mismatches: oracle.mismatches,
    declaration: finish ?? null,
    runtimeStatus: ['completed', 'failed', 'cancelled', 'stopped'].includes(runtimeStatus) ? runtimeStatus : 'unknown',
    attributionCandidates: ['success', 'correct_refusal'].includes(status) ? [] : attributionCandidates(steps),
  };
}
