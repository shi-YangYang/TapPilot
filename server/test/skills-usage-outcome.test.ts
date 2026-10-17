import assert from "node:assert/strict";
import test from "node:test";
import { SkillUsageTracker } from "../src/skills/usage-outcome.js";

const first = "a".repeat(64), second = "b".repeat(64);
const accepted = { actionKind: "input_text", errorCode: "NONE", reason: "NONE", dispatchState: "sent",
  acceptanceState: "accepted", effectState: "changed" } as const;
const refused = { ...accepted, errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", dispatchState: "not_sent",
  acceptanceState: "rejected", effectState: "unknown" } as const;

test("a successful guided action is not blamed for a later unrelated target change", () => {
  const tracker = new SkillUsageTracker();
  tracker.onUsed([first]); tracker.onTrace(accepted); tracker.onTrace(refused);
  assert.deepEqual(tracker.finish({ status: "failed", errorCode: "ACTION_NOT_COMPLETED" }).failedSkillHashes, []);
  assert.deepEqual(tracker.finish({ status: "completed" }).verifiedSkillHashes, []);
  assert.deepEqual(tracker.finish({ status: "completed", businessVerified: true }).verifiedSkillHashes, [first]);
});

test("the directly guided refusal revokes its skill even if the task later recovers", () => {
  const tracker = new SkillUsageTracker();
  tracker.onUsed([first]); tracker.onTrace({ ...accepted, actionKind: "get_ui_tree", dispatchState: "not_applicable",
    acceptanceState: "not_applicable", effectState: "not_applicable" });
  tracker.onTrace(refused); tracker.onTrace(accepted);
  assert.deepEqual(tracker.finish({ status: "completed", businessVerified: true }), {
    usedSkillHashes: [first], failedSkillHashes: [first], verifiedSkillHashes: [],
  });
});

test("a new hint owns the next failure without revoking an earlier successful skill", () => {
  const tracker = new SkillUsageTracker();
  tracker.onUsed([first]); tracker.onTrace(accepted);
  tracker.onUsed([second]); tracker.onTrace(refused);
  assert.deepEqual(tracker.finish({ status: "failed" }).failedSkillHashes, [second]);
});

test("unknown dispatched effects and safety failures conservatively quarantine used advice", () => {
  for (const trace of [{ ...accepted, dispatchState: "unknown", acceptanceState: "unknown", effectState: "unknown" } as const,
    { ...refused, errorCode: "SENSITIVE_FIELD", reason: "SENSITIVE_TARGET" } as const]) {
    const tracker = new SkillUsageTracker();
    tracker.onUsed([first]); tracker.onTrace(accepted); tracker.onTrace(trace);
    assert.deepEqual(tracker.finish({ status: "completed", businessVerified: true }).failedSkillHashes, [first]);
  }
});

test("network interruption is not a failed skill but unsafe business evidence is", () => {
  const tracker = new SkillUsageTracker(); tracker.onUsed([first]);
  assert.deepEqual(tracker.finish({ status: "failed", errorCode: "MODEL_TIMEOUT" }).failedSkillHashes, []);
  assert.deepEqual(tracker.finish({ status: "completed", businessVerified: true, falseCompletion: true }).failedSkillHashes, [first]);
});
