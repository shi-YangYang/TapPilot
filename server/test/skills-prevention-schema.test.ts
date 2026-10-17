import assert from "node:assert/strict";
import test from "node:test";
import { compilePreventiveSkill, compileSkill, predicateMatches, SKILL_POLICY_REVISION, SkillFactsSchema, SkillSpecSchema, skillHash } from "../src/skills/schema.js";
import { compactTrace, factsFromTrace } from "../src/skills/trace.js";

const tree = { snapshotId: "fixture:1", packageName: "fixture", windowId: 1, truncated: false, changedLabelNodeIds: ["status"], nodes: [
  { nodeId: "input", editable: true, enabled: true, visible: true }, { nodeId: "status", enabled: true, visible: true },
] };
const facts = { ...factsFromTrace(compactTrace({ index: 0, before: tree, after: tree, diagnostic: {
  actionKind: "get_ui_tree", errorCode: "NONE", reason: "NONE", dispatchState: "not_applicable", acceptanceState: "not_applicable", effectState: "not_applicable",
} })), observedLabelChanges: "yes" as const };
const program = { entry: 0, nodes: [
  { kind: "step", operation: { op: "inspect_changed_labels" }, next: 1 },
  { kind: "step", operation: { op: "allow_unrelated_status_labels" }, next: 2 },
  { kind: "step", operation: { op: "input_requested_text", source: "current_task_requested_text" }, next: 3 },
  { kind: "end", outcome: "continue" },
] };
const skill = () => SkillSpecSchema.parse({ schemaVersion: 1,
  scope: { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: "a".repeat(64) },
  trigger: { actionKind: "input_text", errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED" },
  entryConditions: [], program, prevention: { entryConditions: [{ fact: "observedLabelChanges", test: "eq", value: "yes" }], program },
  lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 60_000,
});

test("optional prevention has independent bounded conditions, program and identity", () => {
  const current = skill(), { prevention: _prevention, ...legacy } = current;
  assert.deepEqual(SkillSpecSchema.parse(legacy), legacy);
  assert.notEqual(skillHash(current), skillHash(legacy));
  assert.deepEqual(compilePreventiveSkill(legacy, facts), []);
  const { observedLabelChanges: _observed, ...oldFacts } = facts;
  assert.equal(SkillFactsSchema.parse(oldFacts).observedLabelChanges, "unknown");
  assert.equal(predicateMatches({ fact: "observedLabelChanges", test: "eq", value: "unknown" }, oldFacts), true);
  assert.deepEqual(compilePreventiveSkill(current, oldFacts), []);
  assert.equal(SkillSpecSchema.safeParse({ ...current, prevention: { ...current.prevention, text: "private" } }).success, false);
  assert.equal(SkillSpecSchema.safeParse({ ...current, prevention: { ...current.prevention, program: { entry: 0, nodes: [
    { kind: "step", operation: { op: "inspect_changed_labels" }, next: 0 }, { kind: "end", outcome: "continue" },
  ] } } }).success, false);
});

test("prevention needs fresh complete label-only proof and retains semantic/native protection", () => {
  const current = skill(), advice = compilePreventiveSkill(current, facts).join("\n");
  assert.match(advice, /current decision window/);
  assert.match(advice, /previous label IDs and allowances cannot carry over/);
  assert.match(advice, /never replays a preceding mutation/);
  assert.match(advice, /not evidence that ignoring it is safe/);
  assert.match(advice, /current-snapshot IDs as allowedLabelChanges/);
  assert.match(advice, /Never allow recipient, account, amount/);
  assert.match(advice, /Only when required by the current task/);
  for (const update of [
    { hasObservation: false }, { observedLabelChanges: "unknown" as const }, { observedLabelChanges: "no" as const },
    { complete: "no" as const }, { contextChanged: "unknown" as const }, { contextChanged: "yes" as const },
    { structureChanged: "yes" as const }, { structureChanged: "unknown" as const },
    { changedLabelsPresent: "unknown" as const }, { changedLabelCount: 0 },
  ]) assert.deepEqual(compilePreventiveSkill(current, { ...facts, ...update }), []);
  // Observed initial refreshes cannot satisfy the existing recovery path's native refusal gate.
  assert.match(compileSkill(current, facts).join("\n"), /native rejection before dispatch/);
  assert.doesNotMatch(compileSkill(current, facts).join("\n"), /pass those explicitly reviewed/);
});

test("prevention cannot assume a selected target, prior action or native rejection", () => {
  const current = skill();
  for (const fact of ["targetPresent", "targetEditable", "priorActionAccepted", "priorEffectUnknown", "nativeContextChange", "labelOnlyContextChange"] as const) {
    const assumed = SkillSpecSchema.parse({ ...current, prevention: { ...current.prevention, entryConditions: [{ fact, test: "eq", value: "yes" }] } });
    assert.deepEqual(compilePreventiveSkill(assumed, { ...facts, [fact]: "yes" }), [], fact);
  }
  const branched = SkillSpecSchema.parse({ ...current, prevention: { entryConditions: [], program: { entry: 0, nodes: [
    { kind: "branch", condition: { fact: "targetEditable", test: "eq", value: "yes" }, yes: 1, no: 2 },
    { kind: "step", operation: { op: "input_requested_text", source: "current_task_requested_text" }, next: 3 },
    { kind: "step", operation: { op: "inspect", aspect: "context" }, next: 3 },
    { kind: "end", outcome: "continue" },
  ] } } });
  const advice = compilePreventiveSkill(branched, { ...facts, targetEditable: "yes" }).join("\n");
  assert.match(advice, /Check the current app, session and recipient context/);
  assert.doesNotMatch(advice, /pass the already user-requested text/);
});
