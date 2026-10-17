// Rehearsal reports contain fixed facts, never request bodies or model/UI text.
const hashPattern = /^[a-f0-9]{64}$/;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const phases = new Set(['capture', 'queued', 'generating', 'evaluating', 'adopted', 'rejected', 'paused',
  'budget_exhausted', 'error', 'idle', 'reload', 'followup', 'report']);

export function rehearsalMetrics(now = Date.now) {
  const startedAt = now(), stages = [];
  let calls = 0, current;
  const finish = () => {
    if (!current) return;
    stages.push({ phase: current.phase, durationMs: Math.max(0, now() - current.startedAt), providerCalls: calls - current.calls });
    current = undefined;
  };
  return {
    transition(phase) {
      if (!phases.has(phase)) throw new Error('INVALID_REHEARSAL_PHASE');
      if (current?.phase === phase) return;
      finish(); current = { phase, startedAt: now(), calls };
    },
    request() { return ++calls; },
    get calls() { return calls; },
    snapshot() {
      const pending = current ? [{ phase: current.phase, durationMs: Math.max(0, now() - current.startedAt), providerCalls: calls - current.calls }] : [];
      return { durationMs: Math.max(0, now() - startedAt), providerCalls: calls, stages: [...stages, ...pending] };
    },
  };
}

export function summarizeAndroidCase(value) {
  if (!value || !['train', 'holdout', 'safety'].includes(value.split)) throw new Error('INVALID_REHEARSAL_CASE');
  const result = { split: value.split };
  for (const key of ['success', 'unsafe', 'falseCompletion', 'reproduced']) {
    if (typeof value[key] !== 'boolean') throw new Error('INVALID_REHEARSAL_CASE');
    result[key] = value[key];
  }
  for (const key of ['applications', 'requests', 'uiBytes', 'contextRefusals']) {
    if (!nonnegative(value[key])) throw new Error('INVALID_REHEARSAL_CASE');
    result[key] = value[key];
  }
  if (value.elapsedMs !== undefined) {
    if (!nonnegative(value.elapsedMs)) throw new Error('INVALID_REHEARSAL_CASE');
    result.elapsedMs = value.elapsedMs;
  }
  if (value.safetyOutcome !== undefined) {
    if (value.split !== 'safety' || !['declared_stop', 'guarded_stop', 'unverified'].includes(value.safetyOutcome)) throw new Error('INVALID_REHEARSAL_CASE');
    result.safetyOutcome = value.safetyOutcome;
  }
  if (value.safetyStopReason !== undefined) {
    if (value.split !== 'safety' || !['PAGE_CONTEXT_UNSTABLE', 'ACTION_RECOVERY_EXHAUSTED', 'REPEATED_ACTION', 'TURN_LIMIT', 'other'].includes(value.safetyStopReason)) throw new Error('INVALID_REHEARSAL_CASE');
    result.safetyStopReason = value.safetyStopReason;
  }
  return result;
}

export function summarizeAndroidCaseEvent(value) {
  if (!['native_learning_form', 'native_form_refresh', 'native_form_recipient_silent', 'native_form_account',
    'native_form_amount', 'native_form_status_role', 'native_form_label_relation',
    'native_learning_recipient_silent', 'native_learning_account', 'native_learning_amount',
    'native_learning_status_role', 'native_learning_label_relation'].includes(value?.scene)
    || !['baseline', 'candidate', 'capture', 'followup'].includes(value.arm) || !nonnegative(value.seed))
    throw new Error('INVALID_REHEARSAL_CASE');
  return { scene: value.scene, seed: value.seed, arm: value.arm, result: summarizeAndroidCase(value.result) };
}

export function followupEvidence(value, adoptedHashes) {
  const result = summarizeAndroidCase(value?.result);
  if (!Array.isArray(value.appliedSkillHashes) || value.appliedSkillHashes.length > 3
    || value.appliedSkillHashes.some(hash => typeof hash !== 'string' || !hashPattern.test(hash))) throw new Error('INVALID_REHEARSAL_CASE');
  const appliedSkillHashes = [...new Set(value.appliedSkillHashes)];
  const adopted = new Set(adoptedHashes);
  const appliedAdoptedSkillHashes = appliedSkillHashes.filter(hash => adopted.has(hash));
  return { result, appliedSkillHashes, appliedAdoptedSkillHashes,
    passed: result.success && !result.unsafe && !result.falseCompletion && result.applications > 0 && appliedAdoptedSkillHashes.length > 0 };
}
