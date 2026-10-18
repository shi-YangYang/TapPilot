import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedRealAppCall, parseRealAppModelArguments, realAppModelCompletion, realAppModelTools,
  realAppUiEvidence, realAppInitialEvidence, realAppBehaviorEvidence, runRealAppModel, sanitizedRealAppStep, sanitizedRealAppOracle, waitForRealAppForeground } from '../real-app-model.mjs';
import { realAppCases, resolveRealAppCase } from '../real-app-cases.mjs';

test('real app model lane blocks exits and preserves input production tool schemas', () => {
  assert.equal(allowedRealAppCall('act_and_observe', { action: 'open_settings', arguments: {} }), false);
  assert.equal(allowedRealAppCall('act_and_observe', { action: 'press_key', arguments: { key: 'home' } }), false);
  assert.equal(allowedRealAppCall('act_and_observe', { action: 'press_key', arguments: { key: 'back' } }), true);
  assert.equal(allowedRealAppCall('act_and_observe', { action: 'tap_element', arguments: { nodeId: 'node' } }), true);
  assert.equal(allowedRealAppCall('open_settings', {}), false);
  const action = kind => ({ properties: { action: { const: kind }, arguments: { type: 'object', properties: { observed: { const: true } } } } });
  const navigation = { properties: { action: { const: 'press_key' }, arguments: { type: 'object', properties: { key: { type: 'string', enum: ['back', 'home', 'recents'] } } } } };
  const original = [{ name: 'act_and_observe', inputSchema: { properties: { action: { enum: ['tap_element', 'open_settings', 'press_key'] } }, oneOf: [action('tap_element'), action('open_settings'), navigation] } }];
  const tools = realAppModelTools(original);
  assert.deepEqual(tools[0].inputSchema.properties.action.enum, ['tap_element', 'press_key']);
  assert.deepEqual(tools[0].inputSchema.oneOf[0], action('tap_element'));
  assert.deepEqual(tools[0].inputSchema.oneOf[1].properties.arguments.properties.key.enum, ['back']);
  assert.deepEqual(original[0].inputSchema.properties.action.enum, ['tap_element', 'open_settings', 'press_key']);
  assert.deepEqual(navigation.properties.arguments.properties.key.enum, ['back', 'home', 'recents']);
  assert.equal(tools.length, 1, 'the harness must not inject a shortcut completion tool');
  assert.equal(tools.some(tool => ['finish_evaluation', 'finish_task'].includes(tool.name)), false, 'only the production runtime owns completion');
});

test('model lane persists only fixed evidence fields, never screen or provider data', () => {
  const secret = 'private-screen-or-provider-value';
  const step = sanitizedRealAppStep({ index: 0, name: 'act_and_observe', args: { action: 'tap_element', arguments: { snapshotId: 'latest', nodeId: 'n', text: secret } },
    durationMs: 8.4, sinceObservationMs: 321.5, beforeTree: { snapshotId: 'latest', windowId: 1, nodes: [{ nodeId: 'n', text: secret, resourceId: secret, clickable: true }] },
    response: { ok: false, error: { code: 'TARGET_CHANGED', message: secret, details: { reason: 'PAGE_CONTEXT_CHANGED',
      contextChange: { region: 'outside_target', kind: 'structure', changedNodes: 1, targetMatched: true, actionTargetMatched: false, secret }, dispatchState: 'not_sent' } },
      observation: { packageName: 'com.xunmeng.pinduoduo', windowId: 1, nodes: [{ text: secret }], quality: { status: 'usable' } } } });
  assert.equal(step.reason, 'PAGE_CONTEXT_CHANGED');
  assert.equal(step.dispatch, 'not_sent');
  assert.equal(step.target.clickable, true);
  assert.equal(step.nodeCount, 1);
  assert.equal(step.sinceObservationMs, 322);
  assert.deepEqual(step.contextChange, { region: 'outside_target', kind: 'structure', changedNodes: 1, targetMatched: true, actionTargetMatched: false });
  assert.equal(JSON.stringify(step).includes(secret), false);
  const oracle = sanitizedRealAppOracle({ schemaVersion: 1, verdict: 'verified', packageMatched: true, queryVisible: true,
    resultMarkerCount: 3, rawUi: secret, reply: secret, apiKey: secret });
  assert.deepEqual(oracle, { schemaVersion: 1, verdict: 'verified', packageMatched: true, queryVisible: true, resultMarkerCount: 3 });
  assert.equal(sanitizedRealAppOracle({ schemaVersion: 1, verdict: secret }), null);
});

test('native context evidence preserves bounded counts and categories without label handles', () => {
  const secret = 'private-label-handle';
  const input = { index: 0, name: 'act_and_observe', durationMs: 1,
    args: { action: 'tap_element', arguments: {} },
    response: { ok: true, result: { action: { contextVerification: 'native_tab_navigation', allowedLabelChangesCount: 0, automaticLabelChangesCount: 1 } } } };
  const automatic = sanitizedRealAppStep(input);
  assert.equal(automatic.contextVerification, 'native_tab_navigation');
  assert.equal(automatic.allowedLabelChangesCount, 0);
  assert.equal(automatic.automaticLabelChangesCount, 1);
  assert.equal(automatic.requestedLabelAllowanceCount, 0);
  const declared = structuredClone(input);
  declared.args.arguments.allowedLabelChanges = [secret];
  declared.response.result.action = { contextVerification: 'explicit_label_changes', allowedLabelChangesCount: 1 };
  const explicit = sanitizedRealAppStep(declared);
  assert.equal(explicit.contextVerification, 'explicit_label_changes');
  assert.equal(explicit.allowedLabelChangesCount, 1);
  assert.equal(explicit.requestedLabelAllowanceCount, 1);
  assert.equal(JSON.stringify(explicit).includes(secret), false);
  const refused = sanitizedRealAppStep({ ...declared, response: { ok: false, error: { code: 'TARGET_CHANGED' } } });
  assert.equal(refused.requestedLabelAllowanceCount, 1);
  assert.equal(refused.contextVerification, undefined);
  assert.equal(refused.allowedLabelChangesCount, undefined);
  for (const invalid of [null, secret, [], [null], [''], [secret, secret], ['x'.repeat(65)], Array.from({ length: 9 }, (_, i) => `${secret}${i}`)]) {
    assert.equal(sanitizedRealAppStep({ ...input, args: { action: 'tap_element', arguments: { allowedLabelChanges: invalid } } }).requestedLabelAllowanceCount, undefined);
  }
  for (const invalid of [undefined, null, -1, 9, 0.5, secret]) {
    const filtered = sanitizedRealAppStep({ ...input, response: { ok: true,
      result: { action: { contextVerification: secret, allowedLabelChangesCount: invalid, automaticLabelChangesCount: invalid } } } });
    assert.equal(filtered.contextVerification, undefined);
    assert.equal(filtered.allowedLabelChangesCount, undefined);
    assert.equal(filtered.automaticLabelChangesCount, undefined);
    assert.equal(JSON.stringify(filtered).includes(secret), false);
  }
});

test('target diagnostics require the latest snapshot and retain only bounded readiness evidence', () => {
  const secret = 'private-resource-class-or-ui';
  const beforeTree = { snapshotId: 'latest', nodes: [{ nodeId: 'n0', resourceId: secret, className: secret, scrollable: true }] };
  const response = { ok: true, result: {
    observationWait: { status: 'timed_out', ready: false, message: secret },
    observation: { snapshotId: 'next', packageName: resolveRealAppCase().packageName,
      readiness: { status: 'ready', reason: 'known_window', samples: 0, waitedMs: 0, text: secret },
      nodes: [{ clickable: true }, { editable: true }, { scrollable: true }, { scrollable: true, enabled: false }] },
  } };
  const argumentsFor = snapshotId => ({ index: 0, name: 'act_and_observe', durationMs: 1, beforeTree, response,
    args: { action: 'scroll', arguments: { ...(snapshotId === undefined ? {} : { snapshotId }), nodeId: 'n0' } } });
  const latest = sanitizedRealAppStep(argumentsFor('latest'));
  assert.equal(latest.requestedSnapshotIsLatest, true);
  assert.equal(latest.target.scrollable, true);
  assert.equal(latest.target.hasResourceId, true);
  assert.equal(latest.target.classKind, 'other');
  assert.deepEqual(latest.readiness, { status: 'ready', reason: 'known_window', samples: 0, waitedMs: 0 });
  assert.deepEqual(latest.observationWait, { status: 'timed_out', ready: false });
  assert.deepEqual(latest.observedActionableCounts, { clickable: 1, editable: 1, scrollable: 1 });
  assert.equal(JSON.stringify(latest).includes(secret), false);
  const stale = sanitizedRealAppStep(argumentsFor('older'));
  assert.equal(stale.requestedSnapshotIsLatest, false);
  assert.equal(stale.target, undefined, 'reused n0 in a different snapshot must not identify this target');
  const missing = sanitizedRealAppStep(argumentsFor(undefined));
  assert.equal(missing.requestedSnapshotIsLatest, undefined);
  assert.equal(missing.target, undefined);
  response.result.observation.readiness = { status: secret, reason: secret };
  response.result.observationWait = { status: 'timed_out', ready: true };
  const invalid = sanitizedRealAppStep(argumentsFor('latest'));
  assert.equal(invalid.readiness, undefined);
  assert.equal(invalid.observationWait, undefined);
});

test('failed Markor actions report only fixed public control roles and changed field names', () => {
  const packageName = 'net.gsantner.markor';
  const secret = 'private-note-or-description';
  const control = (nodeId, id, attributes = {}) => ({ nodeId, resourceId: `${packageName}:id/${id}`, ...attributes });
  const beforeTree = { snapshotId: 'latest', packageName, nodes: [
    control('save', 'action_save', { enabled: true, contentDescription: secret, bounds: [1, 2, 3, 4] }),
    control('search', 'action_search', { clickable: false, visible: true }),
    control('query', 'searchEditText', { text: secret }),
    control('result', 'resultTextView', { text: secret }),
    control('editor', 'document__fragment__edit__highlighting_editor', { text: secret, focused: false }),
    control('unknown', secret, { text: secret }),
  ] };
  const after = { packageName, nodes: [
    control('new-save', 'action_save', { enabled: false, contentDescription: `${secret}-changed`, bounds: [1, 2, 30, 40] }),
    control('new-search', 'action_search'), // Compact defaults are unchanged.
    control('undo', 'action_undo', { contentDescription: secret }),
    control('new-result-a', 'resultTextView', { text: `${secret}-changed` }),
    control('new-result-b', 'resultTextView', { text: secret }),
    control('new-editor', 'document__fragment__edit__highlighting_editor', { text: `${secret}-changed`, focused: true }),
    control('unknown', `${secret}-changed`, { text: `${secret}-changed` }),
  ] };
  const step = sanitizedRealAppStep({ index: 0, name: 'act_and_observe', durationMs: 1, packageName, beforeTree,
    args: { action: 'tap_element', arguments: { snapshotId: 'latest', nodeId: 'save' } },
    response: { ok: false, error: { code: 'TARGET_CHANGED' }, observation: after } });
  assert.equal(step.targetRole, 'save');
  assert.deepEqual(step.changedKnownControls, [
    { role: 'save', fields: ['contentDescription', 'bounds', 'enabled'] },
    { role: 'undo', fields: ['presence'] },
    { role: 'search_query', fields: ['presence'] },
    { role: 'search_result', fields: ['ambiguous'] },
    { role: 'note_editor', fields: ['text', 'focused'] },
  ]);
  assert.ok(step.changedKnownControls.length <= 20);
  const serialized = JSON.stringify(step);
  for (const forbidden of [secret, packageName, 'action_save', 'resultTextView', 'document__fragment__edit__highlighting_editor']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes('[1,2,30,40]'), false, 'bounds values must not be persisted');
});

test('public control diagnostics do not attribute stale, successful, foreign or ambiguous targets', () => {
  const packageName = 'net.gsantner.markor';
  const save = { nodeId: 'n0', resourceId: `${packageName}:id/action_save`, enabled: true };
  const input = { index: 0, name: 'act_and_observe', durationMs: 1, packageName,
    args: { action: 'tap_element', arguments: { snapshotId: 'latest', nodeId: 'n0' } },
    beforeTree: { snapshotId: 'latest', packageName, nodes: [save] },
    response: { ok: false, error: { code: 'TARGET_CHANGED' },
      observation: { packageName, nodes: [{ ...save, enabled: false }] } },
  };
  for (const alter of [
    candidate => { candidate.args.arguments.snapshotId = 'older'; },
    candidate => { delete candidate.args.arguments.snapshotId; },
    candidate => { candidate.response.ok = true; },
    candidate => { delete candidate.response.ok; },
    candidate => { candidate.packageName = 'arbitrary.app'; },
    candidate => { candidate.beforeTree.packageName = 'arbitrary.app'; },
    candidate => { candidate.beforeTree.nodes = Array.from({ length: 501 }, () => ({ ...save })); },
  ]) {
    const candidate = structuredClone(input);
    alter(candidate);
    const step = sanitizedRealAppStep(candidate);
    assert.equal(step.targetRole, undefined);
    assert.equal(step.changedKnownControls, undefined);
  }
  const foreignAfter = structuredClone(input);
  foreignAfter.response.observation.packageName = 'arbitrary.app';
  const foreignStep = sanitizedRealAppStep(foreignAfter);
  assert.equal(foreignStep.targetRole, 'save');
  assert.equal(foreignStep.changedKnownControls, undefined, 'a different app cannot identify control changes');

  const duplicate = structuredClone(input);
  duplicate.beforeTree.nodes.push({ ...save, nodeId: 'n1', enabled: false });
  const duplicateStep = sanitizedRealAppStep(duplicate);
  assert.equal(duplicateStep.targetRole, undefined);
  assert.deepEqual(duplicateStep.changedKnownControls, [{ role: 'save', fields: ['ambiguous'] }]);
  const reusedId = structuredClone(input);
  reusedId.beforeTree.nodes.push({ nodeId: 'n0', resourceId: `${packageName}:id/action_search` });
  assert.equal(sanitizedRealAppStep(reusedId).targetRole, undefined);

  const missing = structuredClone(input);
  missing.beforeTree.nodes = [];
  const missingStep = sanitizedRealAppStep(missing);
  assert.equal(missingStep.targetRole, undefined);
  assert.deepEqual(missingStep.changedKnownControls, [{ role: 'save', fields: ['presence'] }]);
  const unknown = structuredClone(input);
  unknown.beforeTree.nodes[0].resourceId = `arbitrary.app:id/action_save`;
  assert.equal(sanitizedRealAppStep(unknown).targetRole, undefined, 'matching suffixes do not identify a public role');
});

test('preflight waits for a transient old foreground without sending mutations', async () => {
  let calls = 0;
  const client = { execute: async name => {
    assert.equal(name, 'get_current_app');
    return ++calls === 1 ? { ok: false, error: { code: 'NO_ACTIVE_WINDOW' } } : { ok: true, result: { packageName: 'com.xunmeng.pinduoduo' } };
  } };
  await waitForRealAppForeground(client, AbortSignal.timeout(1000));
  assert.equal(calls, 2);
});

test('saved model arguments keep PDD compatibility and bind each fixed case to its app', () => {
  const required = ['--use-saved-model', '--serial', 'emulator-5580', '--output', '/tmp/model-report.json'];
  const old = parseRealAppModelArguments([...required, '--query', '文具']);
  const pdd = resolveRealAppCase('pdd-search', { query: '文具' });
  assert.equal(old.caseId, pdd.id);
  assert.equal(old.packageName, pdd.packageName);
  assert.equal(old.launchComponent, pdd.launchComponent);
  assert.equal(old.query, '文具');
  assert.ok(realAppCases.length >= 3, 'the three observed app cases must be registered');
  for (const spec of realAppCases) {
    const args = parseRealAppModelArguments([...required, '--case', spec.id]);
    assert.equal(args.packageName, spec.packageName);
    assert.equal(args.launchComponent, spec.launchComponent);
    assert.equal(args.query, undefined);
    assert.throws(() => parseRealAppModelArguments([...required, '--case', spec.id, '--query', 'override']), /FIXED_CASE_QUERY_REQUIRED/);
    assert.throws(() => parseRealAppModelArguments([...required, '--case', spec.id,
      '--launch-component', 'arbitrary.app/.MainActivity']), /INVALID_LAUNCH_COMPONENT/);
  }
  assert.throws(() => parseRealAppModelArguments([...required, '--task', 'send private messages']), /INVALID_ARGUMENT/);
  assert.throws(() => parseRealAppModelArguments([...required, '--package', 'arbitrary.app']), /INVALID_ARGUMENT/);
  assert.throws(() => parseRealAppModelArguments([...required, '--case', 'unregistered-case']), /UNKNOWN_REAL_APP_CASE/);
  assert.throws(() => parseRealAppModelArguments([...required, '--query', '文具\nperform a different task']), /PUBLIC_PRODUCT_QUERY_REQUIRED/);
  assert.throws(() => parseRealAppModelArguments(['--use-saved-model', '--serial', 'usb-phone', '--output', '/tmp/report.json']), /ISOLATED_EMULATOR_REQUIRED/);
});

test('model case mismatch fails before any model request or phone operation', async () => {
  const spec = realAppCases[0];
  assert.ok(spec);
  let calls = 0;
  await assert.rejects(() => runRealAppModel({ caseId: spec.id,
    session: { serial: 'emulator-5580', packageName: resolveRealAppCase().packageName,
      client: { execute: () => { calls++; } } },
    modelFetch: () => { calls++; },
  }), /REAL_APP_CASE_MISMATCH/);
  assert.equal(calls, 0);
});

test('initial setup evidence requires a complete starting page and rejects an already reached goal', () => {
  const spec = resolveRealAppCase('clock-stopwatch');
  const node = (text, selected) => ({ resourceId: 'org.fossify.clock:id/tab_item_label', text, selected });
  const initial = { packageName: spec.packageName, truncated: false, readiness: { status: 'ready' }, quality: { status: 'usable' },
    nodes: [node('Clock', true), node('Stopwatch', false)] };
  const accepted = realAppInitialEvidence(initial, spec);
  assert.equal(accepted.status, 'passed');
  assert.equal(accepted.goalAlreadySatisfied, false);
  assert.deepEqual(accepted.checks.map(check => check.passed), [true, true]);
  for (const tree of [undefined, { ...initial, truncated: true }, { ...initial, packageName: 'other.app' },
    { ...initial, readiness: { status: 'settling' } }, { ...initial, quality: { status: 'limited' } }]) {
    assert.equal(realAppInitialEvidence(tree, spec).errorCode, 'REAL_APP_INITIAL_STATE_UNVERIFIED');
  }
  for (const nodes of [[node('Clock', false), node('Stopwatch', false)], [node('Clock', true), node('Stopwatch', undefined)],
    [...initial.nodes, node('Stopwatch', false)]]) {
    assert.equal(realAppInitialEvidence({ ...initial, nodes }, spec).errorCode, 'REAL_APP_INITIAL_STATE_MISMATCH');
  }
  const atGoal = { ...initial, nodes: spec.oracle.assertions.map(assertion => ({ ...assertion.selector })) };
  assert.equal(realAppInitialEvidence(atGoal, spec).errorCode, 'REAL_APP_INITIAL_GOAL_ALREADY_SATISFIED');
  const secret = 'private-screen-value';
  const generic = { ...spec, packageName: 'other.public', initialAssertions: [{ id: 'start', selector: { text: secret } }] };
  const result = realAppInitialEvidence({ ...initial, packageName: generic.packageName, nodes: [{ text: secret }] }, generic);
  assert.equal(result.status, 'passed', 'the setup check is case-driven, not a Clock package branch');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(realAppInitialEvidence(undefined, resolveRealAppCase('pdd-search')), { status: 'not_required' });
});

test('a persisted Clock destination stops before model requests even if the final oracle verifies it', async () => {
  const spec = resolveRealAppCase('clock-stopwatch');
  const calls = [];
  let requests = 0;
  const tree = { snapshotId: 'setup:1', revision: 1, windowId: 1, packageName: spec.packageName,
    truncated: false, readiness: { status: 'ready' }, quality: { status: 'usable' },
    nodes: spec.oracle.assertions.map((assertion, index) => ({ nodeId: `n${index}`, ...assertion.selector })) };
  const report = await runRealAppModel({ caseId: spec.id, timeoutMs: 1000,
    model: { baseUrl: 'https://synthetic.invalid/v1', apiKey: '', model: 'test', vision: false },
    modelFetch: async () => { requests++; throw new Error('UNEXPECTED_MODEL_REQUEST'); },
    session: { serial: 'emulator-5580', packageName: spec.packageName,
      client: { tools: [{ name: 'get_ui_tree', description: 'Read UI', inputSchema: { type: 'object', properties: {} } }],
        execute: async name => {
          calls.push(name);
          if (name === 'get_current_app') return { ok: true, result: { packageName: spec.packageName } };
          assert.equal(name, 'get_ui_tree');
          return { ok: true, result: tree };
        } },
      inspect: async () => ({ schemaVersion: 1, verdict: 'verified', packageMatched: true, observationSampled: true,
        checks: spec.oracle.assertions.map(assertion => ({ id: assertion.id, count: 1, passed: true })) }),
    } });
  assert.equal(report.status, 'failed');
  assert.equal(report.errorCode, 'REAL_APP_INITIAL_GOAL_ALREADY_SATISFIED');
  assert.equal(report.initialObservation.status, 'failed');
  assert.equal(report.completionVerified, true, 'a correct final screen alone cannot repair an invalid start');
  assert.equal(report.modelRequests, 0);
  assert.equal(requests, 0);
  assert.deepEqual(calls, ['get_current_app', 'get_ui_tree']);
});

test('completion requires production completion, independent evidence and passing behavior', () => {
  const secret = 'private-screen-or-provider-value';
  const expectation = { stage: 'assertions', assertions: [{ id: 'final_value', selector: { text: secret, editable: true } }] };
  const value = { schemaVersion: 1, verdict: 'verified', packageMatched: true, observationSampled: true,
    nodeCount: 5, checks: [{ id: 'final_value', count: 1, passed: true, text: secret }], rawUi: secret, apiKey: secret };
  const oracle = sanitizedRealAppOracle(value, expectation);
  assert.deepEqual(oracle.checks, [{ id: 'final_value', count: 1, passed: true }]);
  assert.equal(JSON.stringify(oracle).includes(secret), false);
  const completed = { status: 'completed' };
  const passingBehavior = { status: 'passed' };
  assert.deepEqual(realAppModelCompletion(null, completed, undefined, passingBehavior), { status: 'unverified', completionClaim: true, completionVerified: false });
  assert.equal(realAppModelCompletion(oracle, completed, undefined, passingBehavior).status, 'success');
  assert.equal(realAppModelCompletion(oracle, completed, 'CASE_TIMEOUT', passingBehavior).status, 'failed');
  assert.equal(realAppModelCompletion(oracle, { status: 'cancelled' }, undefined, passingBehavior).status, 'unverified');
  assert.equal(realAppModelCompletion(oracle, { status: 'failed' }, undefined, passingBehavior).status, 'failed');
  assert.equal(realAppModelCompletion(oracle, completed, undefined, { status: 'failed' }).status, 'failed');
  assert.equal(realAppModelCompletion(oracle, completed, undefined, { status: 'not_evaluated' }).status, 'unverified');
  assert.equal(realAppModelCompletion(oracle, undefined, undefined, passingBehavior).status, 'unverified');
  assert.equal(sanitizedRealAppOracle({ ...value, packageMatched: false }, expectation), null);
  assert.equal(sanitizedRealAppOracle({ ...value, checks: [{ id: 'unexpected_id', count: 1, passed: true }] }, expectation), null);
  assert.equal(sanitizedRealAppOracle({ ...value, checks: [{ id: 'final_value', count: 2, passed: true }] }, expectation), null);
  const unverified = sanitizedRealAppOracle({ ...value, verdict: 'unverified', checks: [{ id: 'final_value', count: 0, passed: false }] }, expectation);
  assert.equal(realAppModelCompletion(unverified, completed, undefined, passingBehavior).status, 'unverified');
});

test('Markor model oracle requires its own fixed input rather than the deterministic value', () => {
  const spec = resolveRealAppCase('markor-quicknote');
  assert.equal(spec.modelOracle?.stage, 'assertions');
  const modelInputs = spec.modelOracle.assertions.filter(item => item.selector.editable === true);
  const deterministicInputs = spec.oracle.assertions.filter(item => item.selector.editable === true);
  assert.equal(modelInputs.length, 1);
  assert.equal(deterministicInputs.length, 1);
  assert.notEqual(modelInputs[0].selector.text, deterministicInputs[0].selector.text);
  assert.equal(modelInputs[0].selector.resourceId, deterministicInputs[0].selector.resourceId);
  assert.ok(modelInputs[0].selector.resourceId.startsWith(`${spec.packageName}:id/`));
  assert.ok(spec.modelTask.includes(modelInputs[0].selector.text));
  const oracle = sanitizedRealAppOracle({ schemaVersion: 1, verdict: 'unverified', packageMatched: true,
    observationSampled: true, checks: spec.modelOracle.assertions.map(item => ({ id: item.id,
      count: item.selector.editable === true ? 0 : 1, passed: item.selector.editable !== true })) }, spec.modelOracle);
  assert.equal(realAppModelCompletion(oracle, { status: 'completed' }, undefined, { status: 'passed' }).status, 'unverified');
});

test('step package evidence follows the selected case instead of a hardcoded app', () => {
  for (const spec of realAppCases) {
    const step = sanitizedRealAppStep({ index: 0, name: 'get_ui_tree', args: {}, packageName: spec.packageName,
      durationMs: 1, response: { ok: true, result: { packageName: spec.packageName, nodes: [] } } });
    assert.equal(step.packageMatched, true);
    const other = sanitizedRealAppStep({ index: 1, name: 'get_ui_tree', args: {}, packageName: spec.packageName,
      durationMs: 1, response: { ok: true, result: { packageName: 'arbitrary.app', nodes: [] } } });
    assert.equal(other.packageMatched, false);
  }
});

const behaviorSpec = {
  packageName: 'example.public',
  visibleNavigationTargets: [{ text: 'Target entry' }],
  oracle: { stage: 'assertions', assertions: [
    { id: 'heading', selector: { text: 'Target screen' } },
    { id: 'detail', selector: { text: 'Required detail' } },
  ] },
};
const behaviorTree = nodes => ({ packageName: behaviorSpec.packageName, truncated: false,
  readiness: { status: 'ready' }, quality: { status: 'usable' }, nodes });

test('host-only task matching requires complete goal and never persists selector or UI values', () => {
  const intermediate = realAppUiEvidence(behaviorTree([{ text: 'Target entry' }, { text: 'Target screen' }]), behaviorSpec);
  assert.deepEqual(intermediate, { goalEvaluated: true, goalObserved: false, visibleTargetsEvaluated: true, navigationTargetVisible: true });
  const final = behaviorTree([{ text: 'Target screen' }, { text: 'Required detail' }]);
  assert.equal(realAppUiEvidence(final, behaviorSpec).goalObserved, true);
  assert.equal(realAppUiEvidence({ ...final, truncated: true }, behaviorSpec).goalObserved, false);
  assert.equal(realAppUiEvidence({ ...final, readiness: { status: 'settling' } }, behaviorSpec).goalObserved, false);
  assert.equal(realAppUiEvidence({ ...final, packageName: 'another.app' }, behaviorSpec).goalObserved, false);
  assert.equal(realAppUiEvidence(behaviorTree([{ text: 'Target entry', visible: false }]), behaviorSpec).navigationTargetVisible, false);
  assert.equal(realAppUiEvidence(behaviorTree([{ text: 'Target entry', enabled: false }]), behaviorSpec).navigationTargetVisible, false);
  assert.equal(realAppUiEvidence(behaviorTree([{ text: 'Target entry', password: true }]), behaviorSpec).navigationTargetVisible, false);
  assert.equal(JSON.stringify(intermediate).includes('Target'), true, 'only the fixed field name contains Target');
  assert.equal(JSON.stringify(intermediate).includes('Target entry'), false);
  assert.equal(JSON.stringify(intermediate).includes('example.public'), false);
});

test('goal matching honors model oracle, absence, real input value and explicit checked state', () => {
  const spec = { ...behaviorSpec, modelOracle: { stage: 'assertions', assertions: [
    { id: 'input', selector: { text: 'Public test', editable: true } },
    { id: 'closed', selector: { text: 'Search bar' }, minCount: 0, maxCount: 0 },
    { id: 'off', selector: { text: 'Public switch', checked: false } },
  ] } };
  const nodes = [{ text: 'Public test', editable: true, showingHintText: false }, { text: 'Public switch', checked: false }];
  assert.equal(realAppUiEvidence(behaviorTree(nodes), spec).goalObserved, true);
  assert.equal(realAppUiEvidence(behaviorTree([{ ...nodes[0], showingHintText: true }, nodes[1]]), spec).goalObserved, false);
  assert.equal(realAppUiEvidence(behaviorTree([nodes[0], { text: 'Public switch' }]), spec).goalObserved, false);
  assert.equal(realAppUiEvidence(behaviorTree([...nodes, { text: 'Search bar' }]), spec).goalObserved, false);
});

test('behavior fails rejected swipes toward visible targets and calls after the complete goal', () => {
  const initial = { tool: 'get_ui_tree', goalObserved: false };
  const arrived = { tool: 'act_and_observe', action: 'tap_element', goalObserved: true };
  const finalRead = { tool: 'get_ui_tree', goalObserved: true };
  const result = { status: 'completed', metrics: { completionReads: 1 } };
  const good = realAppBehaviorEvidence({ steps: [initial, arrived, finalRead], result, spec: behaviorSpec });
  assert.equal(good.status, 'passed');
  assert.equal(good.hostCompletionReadsAfterGoal, 1);
  assert.equal(good.modelToolCallsAfterGoal, 0);
  const extra = realAppBehaviorEvidence({ steps: [initial, arrived, { tool: 'get_current_app' }, finalRead], result, spec: behaviorSpec });
  assert.equal(extra.status, 'failed');
  assert.equal(extra.modelToolCallsAfterGoal, 1);
  const noHostRead = realAppBehaviorEvidence({ steps: [initial, arrived, finalRead], result: { metrics: { completionReads: 0 } }, spec: behaviorSpec });
  assert.equal(noHostRead.status, 'failed');
  for (const action of ['scroll', 'swipe']) {
    const rejected = { tool: 'act_and_observe', action, ok: false, priorNavigationTargetVisible: true };
    const report = realAppBehaviorEvidence({ steps: [initial, rejected, arrived, finalRead], result, spec: behaviorSpec });
    assert.equal(report.status, 'failed');
    assert.equal(report.swipeRequestsWhileTargetVisible, 1);
  }
});

test('unsupported local task predicates are explicitly not evaluated rather than passing', () => {
  const spec = { ...behaviorSpec, oracle: { stage: 'unsupported_public_flow' } };
  const result = { status: 'completed', metrics: { completionReads: 1 } };
  const report = realAppBehaviorEvidence({ steps: [{ tool: 'get_ui_tree' }], result, spec });
  assert.equal(report.goalStopStatus, 'not_evaluated');
  assert.equal(report.status, 'not_evaluated');
  const unobserved = realAppBehaviorEvidence({ steps: [{ tool: 'get_ui_tree' }], result, spec: behaviorSpec });
  assert.equal(unobserved.goalStopStatus, 'not_observed');
  assert.equal(unobserved.status, 'not_evaluated');
});


test('public search goal requires query plus independent result markers without loading or blocked gates', () => {
  const spec = resolveRealAppCase('pdd-search', { query: '机械键盘' });
  const evaluate = labels => realAppUiEvidence({ ...behaviorTree(labels.map(text => ({ text }))), packageName: spec.packageName }, spec);
  const results = ['机械键盘', '综合', '销量'];
  assert.equal(evaluate(results).goalEvaluated, true);
  assert.equal(evaluate(results).goalObserved, true);
  assert.equal(evaluate(['机械键盘', '暂无搜索结果']).goalObserved, true);
  assert.equal(evaluate(['机械键盘']).goalObserved, false);
  assert.equal(evaluate(['机械键盘', '综合', '综合']).goalObserved, false, 'duplicate labels are one result marker');
  assert.equal(evaluate(['综合', '销量']).goalObserved, false);
  for (const marker of ['加载中', '加载中…', '加载中...', '请先登录', '登录后搜索', '安全验证', '拖动滑块', '完成验证', '网络不给力']) {
    assert.equal(evaluate([...results, marker]).goalObserved, false, marker);
  }
  assert.equal(evaluate([...results, '微信登录', '其他方式登录', '手机号']).goalObserved, false);
  const hidden = { ...behaviorTree([{ text: '机械键盘' }, { text: '综合' }, { text: '销量', visible: false }]), packageName: spec.packageName };
  assert.equal(realAppUiEvidence(hidden, spec).goalObserved, false);
  assert.equal(realAppUiEvidence({ ...hidden, truncated: true }, spec).goalObserved, false);
  assert.equal(JSON.stringify(evaluate(results)).includes('机械键盘'), false);
});


test('native bounded navigation preserves production schema, scope limits and behavior evidence', () => {
  const navigation = { name: 'navigate_until', inputSchema: { type: 'object', additionalProperties: false,
    properties: { mode: { enum: ['swipe', 'scroll'] }, maxSteps: { type: 'integer', minimum: 1, maximum: 4 } } } };
  assert.deepEqual(realAppModelTools([navigation, { name: 'open_settings' }]), [navigation]);
  assert.equal(allowedRealAppCall('navigate_until', { mode: 'swipe' }), true);
  assert.equal(allowedRealAppCall('navigate_until', { mode: 'scroll' }), true);
  assert.equal(allowedRealAppCall('navigate_until', { mode: 'tap_visual' }), false);
  assert.equal(allowedRealAppCall('navigate_until', { mode: 'open_app' }), false);
  assert.equal(allowedRealAppCall('act_and_observe', { action: 'navigate_until' }), false);
  assert.equal(allowedRealAppCall('act_and_observe', { action: 'press_key', arguments: { key: 'home' } }), false);
  const secret = 'private-selector-candidate-and-error';
  const input = { index: 0, name: 'navigate_until', durationMs: 1000,
    args: { snapshotId: 'latest', mode: 'swipe', stopWhen: { text: secret }, maxSteps: 4 },
    beforeTree: { snapshotId: 'latest', nodes: [{ text: secret }] },
    response: { ok: true, result: { navigation: { completedSteps: 2, stopReason: 'scope_changed', targetFound: false,
      candidateNodeIds: [secret], error: { message: secret } },
      observation: { packageName: 'another.app', nodes: [] } } } };
  const step = sanitizedRealAppStep(input);
  assert.equal(step.action, 'navigate_until');
  assert.equal(step.requestedSnapshotIsLatest, true);
  assert.equal(step.packageMatched, false, 'a batch leaving its app cannot look in scope');
  assert.deepEqual(step.navigation, { completedSteps: 2, stopReason: 'scope_changed', targetFound: false });
  assert.equal(JSON.stringify(step).includes(secret), false);
  for (const malformed of [
    { completedSteps: 5, stopReason: 'max_steps', targetFound: false },
    { completedSteps: 0, stopReason: secret, targetFound: false },
    { completedSteps: 1, stopReason: 'target_found', targetFound: false },
  ]) {
    assert.equal(sanitizedRealAppStep({ ...input, response: { ok: true, result: { navigation: malformed } } }).navigation, undefined);
  }
  const requested = { ...step, priorNavigationTargetVisible: true, ok: false };
  const behavior = realAppBehaviorEvidence({ steps: [requested, { tool: 'act_and_observe', goalObserved: true }, { tool: 'get_ui_tree' }],
    result: { status: 'completed', metrics: { completionReads: 1 } }, spec: behaviorSpec });
  assert.equal(behavior.swipeRequestsWhileTargetVisible, 1);
  assert.equal(behavior.status, 'failed', 'even rejected batch requests must count when a target is visible');
});
