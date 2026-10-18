import test from 'node:test';
import assert from 'node:assert/strict';
import { runMultiAppCase, validateMultiAppCase } from '../multi-app-executor.mjs';
import { validateRealAppAssertions, validateRealAppOptions } from '../real-app-support.mjs';

const packageName = 'org.wikipedia';
const inputId = 'org.wikipedia:id/search_src_text';
const input = value => ({ nodeId: 'input', resourceId: inputId, editable: true, text: value, showingHintText: false });
const tree = nodes => ({ executor: 'node-v1', packageName, snapshotId: 'current', revision: 1, nodes });
const read = nodes => ({ ok: true, result: tree(nodes) });
const action = nodes => ({ ok: true, result: { action: { accepted: true }, observation: tree(nodes), execution: { dispatch: 'sent' } } });
const expectations = [{ id: 'typed', selector: { resourceId: inputId, text: 'Android', editable: true } }];
const spec = { id: 'public-search', packageName, oracle: { stage: 'assertions', assertions: expectations },
  steps: [{ id: 'enter_query', action: 'input_text', selector: { resourceId: inputId, editable: true }, text: 'Android', assertions: expectations }] };
const verified = { schemaVersion: 1, verdict: 'verified', checks: [{ id: 'typed', count: 1, passed: true }] };

function harness(responses, proofs = [verified, verified]) {
  const calls = [], probes = [];
  return { calls, probes, options: { spec,
    client: { async call(name, args) { calls.push({ name, args }); assert.ok(responses.length); return responses.shift(); } },
    async inspect(args) { probes.push(args); assert.ok(proofs.length); return proofs.shift(); },
  } };
}

test('fixed real-app allowlist expands without admitting arbitrary apps or physical phones', () => {
  for (const packageName of ['org.wikipedia', 'de.danoeh.antennapod', 'net.gsantner.markor', 'org.fossify.math', 'org.fossify.filemanager', 'org.schabi.newpipe', 'org.fossify.clock']) {
    assert.equal(validateRealAppOptions({ serial: 'emulator-5580', packageName }).packageName, packageName);
  }
  assert.throws(() => validateRealAppOptions({ serial: 'physical', packageName }), /ISOLATED_EMULATOR_REQUIRED/);
  assert.throws(() => validateRealAppOptions({ serial: 'emulator-5580', packageName: 'org.example' }), /REAL_APP_NOT_ALLOWLISTED/);
});

test('oracle expectations are exact bounded conjunctions with unique safe IDs and default unique matches', () => {
  assert.deepEqual(validateRealAppAssertions(expectations)[0], { ...expectations[0], minCount: 1, maxCount: 1 });
  const absent = { id: 'closed', selector: { resourceId: inputId }, minCount: 0, maxCount: 0 };
  assert.deepEqual(validateRealAppAssertions([absent]), [absent]);
  for (const value of [[], [...expectations, ...expectations], [{ ...expectations[0], minCount: 0 }],
    [{ id: 'x', selector: {} }], [{ id: 'x', selector: { textContains: 'Android' } }],
    [{ id: 'x', selector: { checked: 'true' } }], [{ id: 'x', selector: { text: '\nsecret' } }],
    [{ ...expectations[0], minCount: 2, maxCount: 1 }]]) assert.throws(() => validateRealAppAssertions(value), /INVALID_ORACLE_ASSERTIONS/);
});

test('absence transition requires a previously present control and independent disappearance evidence', async () => {
  const absent = { id: 'search_closed', selector: { resourceId: inputId }, minCount: 0, maxCount: 0 };
  const close = { ...spec, oracle: { stage: 'assertions', assertions: [absent] }, steps: [
    { id: 'close_search', action: 'press_key', key: 'back', requireNewEvidence: true, assertions: [absent] },
  ] };
  const already = harness([read([])], [verified]);
  const early = await runMultiAppCase({ ...already.options, spec: close });
  assert.equal(early.failure, 'REAL_APP_TRANSITION_ALREADY_SATISFIED');
  assert.equal(early.actionCalls, 0);
  const stillThere = harness([read([input('Android')]), action([input('Android')])], [{ verdict: 'unverified' }, verified]);
  assert.equal((await runMultiAppCase({ ...stillThere.options, spec: close })).failure, 'REAL_APP_RESULT_UNVERIFIED');
  const closed = harness([read([input('Android')]), action([])]);
  assert.equal((await runMultiAppCase({ ...closed.options, spec: close })).status, 'passed');
});

test('one accepted action requires independent per-step and fresh final task evidence', async () => {
  const h = harness([read([input('')]), action([input('Android')])]);
  const report = await runMultiAppCase(h.options);
  assert.equal(report.status, 'passed');
  assert.equal(report.actionCalls, 1);
  assert.equal(report.modelCalls, 0);
  assert.equal(report.mutationReplays, 0);
  assert.equal(h.probes.length, 2);
  assert.equal(h.probes[0].stage, 'assertions');
  assert.equal(JSON.stringify(report).includes('Android'), false);
  assert.equal(JSON.stringify(report).includes(inputId), false);
});

test('accepted input and matching hint cannot count as successful entry', async () => {
  const h = harness([read([input('')]), action([{ ...input('Android'), showingHintText: true }])], [verified]);
  const report = await runMultiAppCase(h.options);
  assert.equal(report.failure, 'REAL_APP_INPUT_NOT_VERIFIED');
  assert.equal(report.actionCalls, 1);
  assert.equal(h.probes[0].timeoutMs, 0);
});

test('refusal is never replayed or transformed into success by final oracle', async () => {
  const h = harness([read([input('')]), { ok: false, error: { code: 'TARGET_CHANGED', details: { dispatchState: 'not_sent' } } }], [verified]);
  const report = await runMultiAppCase(h.options);
  assert.equal(report.failure, 'TARGET_CHANGED');
  assert.equal(report.status, 'failed');
  assert.equal(report.actionCalls, 1);
  assert.equal(h.calls.length, 2);
});

test('accepted action without independent business proof fails', async () => {
  const h = harness([read([input('')]), action([input('Android')])], [{ verdict: 'unverified' }, verified]);
  const report = await runMultiAppCase(h.options);
  assert.equal(report.failure, 'REAL_APP_RESULT_UNVERIFIED');
  assert.equal(report.status, 'failed');
});

test('missing target waits once read-only; duplicate target fails immediately', async () => {
  const h = harness([read([]), read([input('')]), action([input('Android')])]);
  assert.equal((await runMultiAppCase(h.options)).status, 'passed');
  assert.equal(h.calls.filter(call => call.name === 'wait_for_ui_change').length, 1);
  const duplicate = harness([read([input(''), { ...input(''), nodeId: 'second' }])], [verified]);
  assert.equal((await runMultiAppCase(duplicate.options)).failure, 'REAL_APP_TARGET_AMBIGUOUS');
  assert.equal(duplicate.calls.length, 1);
});

test('navigation outside selected package stops the workflow', async () => {
  const result = action([input('Android')]); result.result.observation.packageName = 'com.android.settings';
  const h = harness([read([input('')]), result], [verified]);
  assert.equal((await runMultiAppCase(h.options)).failure, 'REAL_APP_SCOPE_CHANGED');
  assert.equal(h.calls.length, 2);
});

test('scroll transition must establish new evidence instead of an already-visible marker', async () => {
  const scroll = { ...spec, steps: [{ id: 'scroll_list', action: 'scroll', selector: { scrollable: true }, direction: 'forward',
    requireNewEvidence: true, assertions: [{ id: 'new_item', selector: { text: 'Example' } }] }] };
  const h = harness([read([{ nodeId: 'list', scrollable: true }, { nodeId: 'item', text: 'Example' }])], [verified]);
  const report = await runMultiAppCase({ ...h.options, spec: scroll });
  assert.equal(report.failure, 'REAL_APP_TRANSITION_ALREADY_SATISFIED');
  assert.equal(report.actionCalls, 0);
});

test('fixed case rejects unsafe navigation and missing independent assertions', () => {
  assert.throws(() => validateMultiAppCase({ ...spec, steps: [{ ...spec.steps[0], action: 'press_key', key: 'home', selector: undefined }] }), /INVALID_REAL_APP_CASE/);
  assert.throws(() => validateMultiAppCase({ ...spec, steps: [{ ...spec.steps[0], assertions: [] }] }), /INVALID_ORACLE_ASSERTIONS/);
});
