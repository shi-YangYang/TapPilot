import test from 'node:test';
import assert from 'node:assert/strict';
import { isPinduoduoLoginGate, runDeterministicSearch, selectTarget } from '../real-app-executor.mjs';
import { launchRealApp, validateLaunchComponent, validateRealAppOptions, waitForRealAppForeground } from '../real-app-support.mjs';

const pkg = 'com.xunmeng.pinduoduo';
const query = '机械键盘';
const tree = nodes => ({ executor: 'node-v1', packageName: pkg, snapshotId: 'current', revision: 4, nodes });
const home = tree([{ nodeId: 'entry', text: '搜索', clickable: true }]);
const editor = value => tree([{ nodeId: 'editor', editable: true, text: value, showingHintText: false }, { nodeId: 'search', text: '搜索' }]);
const read = value => ({ ok: true, result: value });
const accepted = value => ({ ok: true, result: { action: { accepted: true }, observation: value,
  execution: { dispatch: 'sent', verification: 'unverified', effect: 'changed' } } });
const verified = { verdict: 'verified', queryVisible: true, resultMarkerCount: 2 };

function harness(responses, oracle = verified) {
  const calls = [], probes = [];
  return { calls, probes, options: { query,
    client: { async call(name, args) { calls.push({ name, args }); assert.ok(responses.length, 'unexpected tool call'); return responses.shift(); } },
    async inspect(args) { probes.push(args); return oracle; },
  } };
}

test('emulator guard rejects physical devices and arbitrary package/query inputs', () => {
  assert.throws(() => validateRealAppOptions({ serial: 'physical-phone' }), /ISOLATED_EMULATOR_REQUIRED/);
  assert.throws(() => validateRealAppOptions({ serial: 'emulator-5580', packageName: 'com.bank.app' }), /REAL_APP_NOT_ALLOWLISTED/);
  assert.throws(() => validateRealAppOptions({ serial: 'emulator-5580', query: '验证码123456' }), /PUBLIC_PRODUCT_QUERY_REQUIRED/);
  assert.throws(() => validateRealAppOptions({ serial: 'emulator-5580', decisionDelayMs: 15_001 }), /INVALID_DECISION_DELAY/);
});

test('locator accepts compact false flags and refuses duplicate semantic matches', () => {
  assert.deepEqual(selectTarget(editor(query), 'submit', { text: '搜索', editable: false }), { snapshotId: 'current', nodeId: 'search' });
  assert.throws(() => selectTarget(tree([{ nodeId: 'a', text: '搜索' }, { nodeId: 'b', text: '搜索' }]), 'entry'), /TARGET_AMBIGUOUS/);
  assert.throws(() => selectTarget(tree([{ nodeId: 'a', text: '搜索', enabled: false }]), 'entry'), /TARGET_MISSING/);
});

test('deterministic flow dispatches once per step and requires independent success', async () => {
  const h = harness([read(home), accepted(editor('')), accepted(editor(query)), accepted(tree([]))]);
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.status, 'passed');
  assert.equal(report.actionCalls, 3);
  assert.equal(report.modelCalls, 0);
  assert.equal(report.mutationReplays, 0);
  assert.deepEqual(h.calls.map(call => call.args.action).filter(Boolean), ['tap_element', 'input_text', 'tap_element']);
  assert.equal(h.probes.length, 1);
  assert.equal(JSON.stringify(report).includes(query), false, 'public query and UI content must not enter the report');
});

test('native stale refusal ends the case without mutation retry even if oracle sees a result', async () => {
  const contextChange = { region: 'outside_target', kind: 'content', changedNodes: 2, targetMatched: true, actionTargetMatched: true };
  const h = harness([read(home), { ok: false, error: { code: 'TARGET_CHANGED', details: { reason: 'PAGE_CONTEXT_CHANGED', dispatchState: 'not_sent',
    contextChange: { ...contextChange, text: 'must not be retained' } } } }]);
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.status, 'failed');
  assert.equal(report.failure, 'TARGET_CHANGED');
  assert.equal(report.actionCalls, 1);
  assert.equal(report.steps.at(-1).dispatch, 'not_sent');
  assert.equal(report.steps.at(-1).reason, 'PAGE_CONTEXT_CHANGED');
  assert.deepEqual(report.steps.at(-1).contextChange, contextChange);
  assert.ok(report.steps.at(-1).sinceObservationMs >= 0);
  assert.equal(h.calls.length, 2);
});

test('accepted input that transforms or loses the query never submits search', async () => {
  const h = harness([read(editor('')), accepted(editor('transformed'))]);
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.failure, 'REAL_APP_INPUT_NOT_VERIFIED');
  assert.equal(report.actionCalls, 1);
  assert.equal(h.probes[0].stage, 'search_input');
});

test('query text from a hint or unknown hint state never proves input or submits search', async () => {
  for (const hintState of [true, undefined]) {
    const result = editor(query);
    if (hintState === undefined) delete result.nodes[0].showingHintText;
    else result.nodes[0].showingHintText = hintState;
    const h = harness([read(editor('')), accepted(result)]);
    const report = await runDeterministicSearch(h.options);
    assert.equal(report.failure, 'REAL_APP_INPUT_NOT_VERIFIED');
    assert.equal(report.actionCalls, 1);
    assert.equal(h.calls.some(call => call.args.action === 'tap_element'), false);
  }
});

test('one bounded read-only wait can complete delayed editor, never taps twice', async () => {
  const loading = { ...tree([]), observationCapabilities: { readinessWait: true } };
  const h = harness([read(home), accepted(loading), read(editor('')), accepted(editor(query)), accepted(tree([]))]);
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.status, 'passed');
  assert.equal(h.calls.filter(call => call.name === 'wait_for_ui_change').length, 1);
  assert.equal(h.calls.find(call => call.name === 'wait_for_ui_change').args.requireUsable, true);
  assert.equal(report.actionCalls, 3);
});

test('accepted submit is not success when independent UIAutomator cannot verify results', async () => {
  const h = harness([read(editor('')), accepted(editor(query)), accepted(tree([]))], { verdict: 'unverified' });
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.status, 'failed');
  assert.equal(report.failure, 'REAL_APP_RESULT_UNVERIFIED');
  assert.equal(report.actionCalls, 2);
});

test('changing app scope stops before another mutation', async () => {
  const h = harness([read(home), accepted({ ...editor(''), packageName: 'com.android.settings' })]);
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.failure, 'REAL_APP_SCOPE_CHANGED');
  assert.equal(report.actionCalls, 1);
  assert.equal(h.calls.length, 2);
});

test('observed PDD login combination stops before input and ordinary login link does not', async () => {
  const login = tree(['微信登录', '其他方式登录', '手机号'].map((text, index) => ({ nodeId: String(index), text })));
  assert.equal(isPinduoduoLoginGate(login), true);
  assert.equal(isPinduoduoLoginGate(tree([{ nodeId: 'link', text: '微信登录' }, { nodeId: 'search', text: '搜索' }])), false);
  const h = harness([read(login)], { verdict: 'blocked', loginRequired: true });
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.failure, 'REAL_APP_MANUAL_STEP_REQUIRED');
  assert.equal(report.actionCalls, 0);
  assert.equal(h.probes.length, 1);
});

test('launch component cannot target other apps or inject shell arguments', () => {
  assert.equal(validateLaunchComponent(`${pkg}/.ui.activity.MainFrameActivity`), `${pkg}/.ui.activity.MainFrameActivity`);
  assert.equal(validateLaunchComponent(`${pkg}/${pkg}.ui.activity.MainFrameActivity`), `${pkg}/${pkg}.ui.activity.MainFrameActivity`);
  for (const value of ['com.bank.app/.MainActivity', `${pkg}/com.bank.app.MainActivity`, `${pkg}/.MainActivity;input tap 1 1`, `${pkg}/.MainActivity/extra`]) {
    assert.throws(() => validateLaunchComponent(value), /INVALID_LAUNCH_COMPONENT/);
  }
});

test('explicit launch resets only the allowlisted emulator app then performs a readonly foreground wait', async () => {
  const calls = [];
  await launchRealApp({ serial: 'emulator-5580', packageName: pkg, query,
    async adb(...args) { calls.push(args); return 'Status: ok'; },
    client: { async call(name, args) { calls.push([name, args]); return read({ packageName: pkg }); } },
  }, `${pkg}/.ui.activity.MainFrameActivity`);
  assert.deepEqual(calls, [['shell', 'am', 'start', '-S', '-W', '-n', `${pkg}/.ui.activity.MainFrameActivity`], ['get_current_app', {}]]);
});

test('foreground wait handles transient no-root and fails on a bounded wrong-app result', async () => {
  let calls = 0;
  await waitForRealAppForeground({ async execute(name) {
    assert.equal(name, 'get_current_app');
    calls++;
    return calls === 1 ? { ok: false, error: { code: 'NO_ACTIVE_WINDOW' } } : read({ packageName: pkg });
  } }, AbortSignal.timeout(2000), 500);
  assert.equal(calls, 2);
  await assert.rejects(waitForRealAppForeground({ async call() { return read({ packageName: 'com.android.launcher3' }); } }, AbortSignal.timeout(1000), 5), /REAL_APP_NOT_FOREGROUND/);
});

test('cold launch waits once for a missing initial search entry and never replays a tap', async () => {
  const starting = { ...tree([]), windowId: 1, quality: { status: 'limited' }, observationCapabilities: { readinessWait: true } };
  const ready = { ...home, windowId: 1, quality: { status: 'usable' } };
  const h = harness([read(starting), read(ready), accepted(editor('')), accepted(editor(query)), accepted(tree([]))]);
  const report = await runDeterministicSearch(h.options);
  assert.equal(report.status, 'passed');
  const waits = h.calls.filter(call => call.name === 'wait_for_ui_change');
  assert.equal(waits.length, 1);
  assert.deepEqual(waits[0].args, { sinceRevision: 4, snapshotId: 'current', timeoutMs: 5000,
    selector: { contentDescription: '搜索' }, requireUsable: true });
  assert.equal(report.steps[1].stage, 'wait_initial_search_entry');
  assert.equal(report.steps[1].nodeCount, 1);
  assert.equal(report.steps[1].quality, 'usable');
  assert.equal(report.steps[1].windowChanged, false);
  assert.equal(report.actionCalls, 3);
});

test('initial ambiguous target fails immediately and missing explicit target waits only once', async () => {
  const ambiguous = tree([{ nodeId: 'a', text: '搜索' }, { nodeId: 'b', text: '搜索' }]);
  const duplicate = harness([read(ambiguous)], { verdict: 'unverified' });
  assert.equal((await runDeterministicSearch(duplicate.options)).failure, 'REAL_APP_TARGET_AMBIGUOUS');
  assert.equal(duplicate.calls.length, 1);
  const missing = harness([read(tree([])), read(tree([]))], { verdict: 'unverified' });
  const report = await runDeterministicSearch({ ...missing.options, entrySelector: { contentDescription: '搜索' } });
  assert.equal(report.failure, 'REAL_APP_TARGET_MISSING');
  assert.equal(report.actionCalls, 0);
  assert.equal(missing.calls.filter(call => call.name === 'wait_for_ui_change').length, 1);
});
