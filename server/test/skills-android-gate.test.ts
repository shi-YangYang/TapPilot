import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSkill, requiresAndroidEvaluation, SKILL_FIXTURE_MODEL, verifySkillReceipt, SkillEvaluationError } from "../src/skills/evaluation.js";
import { AndroidSkillEvaluationError, type AndroidSkillCaseResult } from "../src/skills/android-evaluation.js";
import { RuntimeError } from "../src/runtime/model.js";
import { modelScope } from "../src/learning/schema.js";
import { SKILL_POLICY_REVISION, SkillSpecSchema, skillHash, type SkillSpec } from "../src/skills/schema.js";
import { createEpisode, type FailureEpisode } from "../src/skills/trace.js";

const scope = { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: modelScope(SKILL_FIXTURE_MODEL).modelProfile };
const trigger = { errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", actionKind: "input_text" } as const;
const facts = { hasObservation: true, complete: "yes", nodeCount: 6, actionableCount: 1, editableCount: 1, scrollableCount: 0,
  focusedCount: 0, focusPresent: "no", imeVisible: "unknown", changedLabelCount: 1, changedLabelsPresent: "yes" } as const;
function episode(native = true): FailureEpisode {
  return createEpisode({ scope, trigger, termination: "failed", appliedSkillHashes: [], steps: [{ index: 0, ...trigger,
    ...(native ? { executor: "node-v1" as const } : {}), dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown",
    contextChange: { region: "outside_target", kind: "content", changedNodes: 1, targetMatched: true, actionTargetMatched: true },
    before: facts, after: facts, target: { present: "yes", clickable: "no", editable: "yes", scrollable: "no", ancestorClickable: "no", visible: "yes", enabled: "yes", focused: "no" },
    changes: { structure: "no", context: "no", focus: "no", ime: "unknown", targetBounds: "no", targetIdentity: "no" },
  }] });
}
function candidate(labels = true): SkillSpec {
  return SkillSpecSchema.parse({ schemaVersion: 1, scope, trigger, entryConditions: [], basis: "hypothesis", expiresAt: Date.now() + 60_000, lineage: { negativeFeedback: [] },
    program: { entry: 0, nodes: [
      { kind: "step", operation: labels ? { op: "inspect_changed_labels" } : { op: "observe", mode: "reuse_latest" }, next: 1 },
      { kind: "end", outcome: "continue" },
    ] } });
}

test("native label candidates cannot get an adoption receipt without a dedicated emulator", async () => {
  let modelRequests = 0;
  await assert.rejects(evaluateSkill(candidate(), episode(), { modelFetch: async () => { modelRequests++; throw new Error("must not call model"); } }),
    { code: "SKILLS_ANDROID_REQUIRED" });
  assert.equal(modelRequests, 0);
});

test("native evaluation refuses a real-phone serial before any ADB or model call", async () => {
  let modelRequests = 0;
  await assert.rejects(evaluateSkill(candidate(), episode(), {
    android: { serial: "synthetic-real-phone-serial", adbPath: "/must-not-execute-adb" },
    modelFetch: async () => { modelRequests++; throw new Error("must not call model"); },
  }), { code: "SKILLS_ANDROID_REQUIRED" });
  assert.equal(modelRequests, 0);
});

test("native evaluation rejects invalid budgets before selecting a device", async () => {
  for (const options of [{ maxModelCalls: NaN }, { maxModelCalls: 0 }, { maxDurationMs: Infinity }, { maxDurationMs: -1 }]) {
    await assert.rejects(evaluateSkill(candidate(), episode(), { ...options, android: { serial: "emulator-5580", adbPath: "/must-not-execute-adb" } }),
      { code: "SKILLS_INVALID_BUDGET" });
  }
});

test("native executor evidence routes an older program through the Android gate", async () => {
  const oldProgram = candidate(false);
  assert.equal(requiresAndroidEvaluation(oldProgram, episode(false)), false);
  assert.equal(requiresAndroidEvaluation(oldProgram, episode(true)), true);
  await assert.rejects(evaluateSkill(oldProgram, episode(true)), { code: "SKILLS_ANDROID_REQUIRED" });
});

test("new label operations cannot receive a synthetic or imported receipt without native validation", async () => {
  for (const op of ["inspect_changed_labels", "allow_unrelated_status_labels"] as const) {
    const proposed = candidate();
    proposed.program.nodes[0] = { kind: "step", operation: { op }, next: 1 };
    const legacy = episode(false);
    assert.equal(requiresAndroidEvaluation(proposed, legacy), true);
    await assert.rejects(evaluateSkill(proposed, legacy), { code: "SKILLS_ANDROID_REQUIRED" });
    for (const contract of ["structural_recovery", "android_recovery"]) {
      assert.throws(() => verifySkillReceipt(proposed, legacy, { passed: true, contract, androidSuite: "native-label-recovery-1", candidateGoals: 11 }), /SKILLS_UNTRUSTED_RECEIPT/);
    }
  }
});

test("an optional prevention program cannot bypass the native adoption gate", async () => {
  const spec = candidate(false);
  spec.prevention = { entryConditions: [], program: spec.program };
  assert.equal(requiresAndroidEvaluation(spec, episode(false)), true);
  await assert.rejects(evaluateSkill(spec, episode(false)), { code: "SKILLS_ANDROID_REQUIRED" });
});

const result = (overrides: Partial<AndroidSkillCaseResult> = {}): AndroidSkillCaseResult => ({
  split: "train", success: true, unsafe: false, falseCompletion: false, reproduced: true,
  applications: 0, requests: 6, contextRefusals: 2, uiBytes: 1234, elapsedMs: 500, ...overrides,
});

test("native rejection preserves actual paired training counters and the correct no-improvement category", () => {
  const spec = candidate(), rows = [17, 29, 43].map(() => ({ baseline: result(), candidate: result({ applications: 3, requests: 7 }) }));
  const native = new AndroidSkillEvaluationError("SKILLS_ANDROID_NO_IMPROVEMENT", spec, rows, "train");
  const error = SkillEvaluationError.fromAndroid(native, spec)!;
  assert.equal(error.feedback.outcome, "no_improvement");
  assert.equal(error.feedback.metric, "model_requests");
  assert.deepEqual(error.evaluationFeedback, { skillHash: skillHash(spec), reason: "no_improvement", pairs: rows.map(() => ({
    baseline: { success: true, unsafe: false, falseCompletion: false, applications: 0, requests: 6, contextRefusals: 2 },
    candidate: { success: true, unsafe: false, falseCompletion: false, applications: 3, requests: 7, contextRefusals: 2 },
  })) });
  rows[0]!.candidate.requests = 999;
  assert.equal(error.evaluationFeedback!.pairs[0]!.candidate.requests, 7, "feedback owns a sanitized copy");
  assert.throws(() => verifySkillReceipt(spec, episode(), error.evaluationFeedback), /SKILLS_UNTRUSTED_RECEIPT/);
});

test("a failed training pair is retained with its measured failure category", () => {
  const spec = candidate();
  for (const [changes, metric] of [
    [{ success: false, unsafe: true }, "safety"],
    [{ success: false, falseCompletion: true }, "false_completion"],
    [{ success: false }, "goal_success"],
  ] as const) {
    const native = new AndroidSkillEvaluationError("SKILLS_ANDROID_REGRESSION", spec,
      [{ baseline: result(), candidate: result({ applications: 1, ...changes }) }], "train");
    const error = SkillEvaluationError.fromAndroid(native, spec)!;
    assert.equal(error.feedback.outcome, "regression");
    assert.equal(error.feedback.metric, metric);
    assert.equal(error.evaluationFeedback!.pairs[0]!.candidate.success, false);
    assert.equal(error.evaluationFeedback!.reason, "regression");
  }
  const noGoal = new AndroidSkillEvaluationError("SKILLS_ANDROID_NO_IMPROVEMENT", spec,
    [{ baseline: result({ success: false }), candidate: result({ success: false, applications: 1 }) }], "train");
  assert.equal(SkillEvaluationError.fromAndroid(noGoal, spec)!.feedback.metric, "goal_success");
  const notApplied = new AndroidSkillEvaluationError("SKILLS_ANDROID_NOT_APPLIED", spec,
    [{ baseline: result(), candidate: result() }], "train");
  const error = SkillEvaluationError.fromAndroid(notApplied, spec)!;
  assert.equal(error.feedback.metric, "unknown");
  assert.equal(error.evaluationFeedback!.reason, "not_applied");
});

test("held-out and safety details never enter proposal feedback or its specific metric", () => {
  const spec = candidate(), training = { baseline: result(), candidate: result({ applications: 3, requests: 4, contextRefusals: 0 }) };
  let previous: unknown;
  for (const split of ["holdout", "safety"] as const) {
    const native = new AndroidSkillEvaluationError("SKILLS_ANDROID_REGRESSION", spec, [training, {
      baseline: result({ split, requests: 777 }), candidate: result({ split, success: false, unsafe: split === "safety", falseCompletion: split === "holdout", requests: 999 }),
    }], split);
    const error = SkillEvaluationError.fromAndroid(native, spec)!;
    assert.equal(error.feedback.metric, "unknown");
    assert.equal(error.evaluationFeedback!.pairs.length, 1);
    assert.equal(JSON.stringify(error.evaluationFeedback).includes("999"), false);
    if (previous) assert.deepEqual(error.evaluationFeedback, previous);
    previous = error.evaluationFeedback;
  }
});

test("feedback remains candidate-bound and strict; arbitrary error fields cannot supply measurements", () => {
  const spec = candidate(), rows = [{ baseline: result(), candidate: result({ applications: 1 }) }];
  const native = new AndroidSkillEvaluationError("SKILLS_ANDROID_NO_IMPROVEMENT", spec, rows, "train");
  assert.throws(() => SkillEvaluationError.fromAndroid(native, { ...spec, expiresAt: spec.expiresAt + 1 }), /SKILLS_FEEDBACK_MISMATCH/);
  assert.throws(() => new SkillEvaluationError("SKILLS_ANDROID_REGRESSION", spec, "unknown", native.evaluationFeedback), /SKILLS_FEEDBACK_MISMATCH/);
  assert.throws(() => new AndroidSkillEvaluationError("SKILLS_ANDROID_NO_IMPROVEMENT", spec, [...rows, ...rows, ...rows, ...rows], "train"));
  assert.throws(() => new AndroidSkillEvaluationError("SKILLS_ANDROID_NO_IMPROVEMENT", spec,
    [{ baseline: result(), candidate: result({ requests: -1 }) }], "train"));
  const imported = Object.assign(new RuntimeError("SKILLS_ANDROID_NO_IMPROVEMENT", "untrusted"), { evaluationFeedback: native.evaluationFeedback });
  const error = SkillEvaluationError.fromAndroid(imported, spec)!;
  assert.equal(error.evaluationFeedback, undefined);
  assert.equal(error.feedback.outcome, "no_improvement");
  assert.equal(error.feedback.metric, "unknown");
  assert.equal(SkillEvaluationError.fromAndroid(new Error("SKILLS_ANDROID_NO_IMPROVEMENT"), spec), undefined);
});
