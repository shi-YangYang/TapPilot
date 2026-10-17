import assert from 'node:assert/strict';
import test from 'node:test';
import { followupEvidence, rehearsalMetrics, summarizeAndroidCase, summarizeAndroidCaseEvent } from '../skill-learning-report.mjs';

const hash = 'a'.repeat(64), other = 'b'.repeat(64);
const result = { split: 'holdout', success: true, unsafe: false, falseCompletion: false, reproduced: true,
  applications: 1, requests: 3, uiBytes: 1000, contextRefusals: 1 };

test('a completed later task must actually use a persisted adopted hash', () => {
  assert.equal(followupEvidence({ result, appliedSkillHashes: [hash] }, [hash]).passed, true);
  assert.equal(followupEvidence({ result, appliedSkillHashes: [other] }, [hash]).passed, false);
  assert.equal(followupEvidence({ result: { ...result, applications: 0 }, appliedSkillHashes: [hash] }, [hash]).passed, false);
  assert.equal(followupEvidence({ result: { ...result, unsafe: true }, appliedSkillHashes: [hash] }, [hash]).passed, false);
  assert.equal(followupEvidence({ result: { ...result, falseCompletion: true }, appliedSkillHashes: [hash] }, [hash]).passed, false);
});

test('case summaries discard arbitrary provider or UI content', () => {
  assert.deepEqual(summarizeAndroidCase({ ...result, text: 'private text', request: { apiKey: 'secret' } }), result);
  assert.throws(() => summarizeAndroidCase({ ...result, success: 'true' }), /INVALID_REHEARSAL_CASE/);
  assert.throws(() => followupEvidence({ result, appliedSkillHashes: ['secret'] }, [hash]), /INVALID_REHEARSAL_CASE/);
  const event = { scene: 'native_learning_form', seed: 2039, arm: 'followup', result: { ...result, elapsedMs: 1200 } };
  assert.deepEqual(summarizeAndroidCaseEvent({ ...event, providerResponse: 'secret' }), event);
  const safety = { ...event, scene: 'native_learning_recipient_silent', result: { ...event.result, split: 'safety' } };
  assert.deepEqual(summarizeAndroidCaseEvent(safety), safety);
  const guarded = { ...safety, result: { ...safety.result, safetyOutcome: 'guarded_stop', safetyStopReason: 'ACTION_RECOVERY_EXHAUSTED' } };
  assert.deepEqual(summarizeAndroidCaseEvent(guarded), guarded);
  assert.throws(() => summarizeAndroidCase({ ...result, safetyOutcome: 'guarded_stop' }), /INVALID_REHEARSAL_CASE/);
  assert.throws(() => summarizeAndroidCase({ ...safety.result, safetyOutcome: 'model was correct' }), /INVALID_REHEARSAL_CASE/);
  assert.throws(() => summarizeAndroidCase({ ...safety.result, safetyStopReason: 'raw error text' }), /INVALID_REHEARSAL_CASE/);
  assert.throws(() => summarizeAndroidCaseEvent({ ...event, scene: 'private app text' }), /INVALID_REHEARSAL_CASE/);
});

test('timing separates stages and counts only explicitly recorded provider requests', () => {
  let time = 0;
  const metrics = rehearsalMetrics(() => time);
  metrics.transition('capture'); metrics.request(); time = 10;
  metrics.transition('generating'); metrics.request(); time = 25;
  metrics.transition('generating'); metrics.request(); time = 30;
  metrics.transition('evaluating'); time = 50;
  assert.deepEqual(metrics.snapshot(), { durationMs: 50, providerCalls: 3, stages: [
    { phase: 'capture', durationMs: 10, providerCalls: 1 },
    { phase: 'generating', durationMs: 20, providerCalls: 2 },
    { phase: 'evaluating', durationMs: 20, providerCalls: 0 },
  ] });
});
