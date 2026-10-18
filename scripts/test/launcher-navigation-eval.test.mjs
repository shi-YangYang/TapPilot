import test from 'node:test';
import assert from 'node:assert/strict';
import { launcherBehaviorEvidence, parseLauncherArguments } from '../launcher-navigation-eval.mjs';

const read = { tool: 'get_ui_tree', ok: true };
const reached = { tool: 'act_and_observe', action: 'tap_element', ok: true, cloneDestinationObserved: true };
const finished = { status: 'completed', answer: '已打开对应入口。', metrics: { completionReads: 1 } };
const evidence = (steps, overrides = {}) => launcherBehaviorEvidence({ steps,
  scene: 'native_launcher_visible', mode: 'model', result: finished, ...overrides });

test('one host completion read is permitted but model re-reads and waits remain failures', () => {
  assert.equal(evidence([read, reached, read]).verified, true);
  const waited = evidence([read, reached, { tool: 'wait_for_ui_change', ok: true }, read]);
  assert.equal(waited.hostCompletionReadsAfterGoal, 1);
  assert.equal(waited.modelToolCallsAfterGoal, 1);
  assert.equal(waited.verified, false);
  assert.equal(evidence([read, reached, read], { result: { ...finished, metrics: { completionReads: 0 } } }).verified, false);
  assert.equal(evidence([read, reached, read, read]).verified, false);
});

test('a refused swipe while the target is visible fails even when the task later reaches the goal', () => {
  const report = evidence([read, { tool: 'act_and_observe', action: 'swipe', ok: false,
    prior: { secondIconPresent: true } }, reached, read]);
  assert.equal(report.swipeRequestsWhileTargetVisible, 1);
  assert.equal(report.verified, false);
  assert.equal(evidence([read, { tool: 'act_and_observe', action: 'swipe', ok: true,
    prior: { secondIconPresent: false } }, reached, read], { scene: 'native_launcher_paged' }).verified, true);
});

test('followup task must observe detail and report its synthetic value, not stop at the app entry', () => {
  const options = { scene: 'native_launcher_followup' };
  assert.equal(evidence([read, reached, read], options).goalObserved, false);
  const detail = { tool: 'act_and_observe', action: 'tap_element', ok: true, noticeDetailsObserved: true };
  assert.equal(evidence([read, reached, detail, read], options).requiredDetailReported, false);
  const correct = evidence([read, reached, detail, read], { ...options,
    result: { ...finished, answer: '活动时间是15:30。' } });
  assert.equal(correct.verified, true);
  assert.equal(JSON.stringify(correct).includes('15:30'), false);
  assert.equal(evidence([read, reached, detail], { ...options, mode: 'executor', result: undefined }).verified, true);
  assert.equal(parseLauncherArguments(['--serial', 'emulator-5580', '--case', 'native_launcher_followup']).case,
    'native_launcher_followup');
});
