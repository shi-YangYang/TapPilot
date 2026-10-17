import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticEventSchema } from "../src/diagnostics/schema.js";
import { compileSkill, SKILL_POLICY_REVISION, SkillOperationSchema, SkillSpecSchema } from "../src/skills/schema.js";
import { compactObservation, compactTrace, factsFromTrace, TraceStepSchema } from "../src/skills/trace.js";
import { SkillSession } from "../src/skills/runtime.js";

const privateLabel = "private-recipient-account-password-验证码";
const target = "private-target-id", status = "private-status-id";
const tree = (revision: number, label = privateLabel) => ({ snapshotId: `private-session:${revision}`, packageName: "private.app", windowId: 1, truncated: false,
  nodes: [
    { nodeId: "private-root-id", className: "android.widget.LinearLayout", enabled: true, visible: true },
    { nodeId: target, parentId: "private-root-id", resourceId: "private.input", className: "android.widget.EditText", editable: true, focused: true, enabled: true, visible: true, bounds: [0, 20, 100, 40] },
    { nodeId: status, parentId: "private-root-id", className: "android.widget.TextView", text: label, contentDescription: privateLabel, enabled: true, visible: true, bounds: [0, 0, 100, 10] },
  ] });
const before = tree(1), after = { ...tree(2, "new-private-label-value"), changedLabelNodeIds: [status] };
const event = DiagnosticEventSchema.parse({ schemaVersion: 1, eventType: "tool_result", runId: "00000000-0000-4000-8000-000000000001", timestamp: 1, stepIndex: 0,
  versions: { host: "0.3.19" }, actionKind: "input_text", outcome: "failure", failureStage: "phone_validation", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown",
  executor: "node-v1", errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED",
  contextChange: { region: "outside_target", kind: "content", changedNodes: 1, targetMatched: true, actionTargetMatched: true } });
const trace = () => compactTrace({ index: 0, before, after, targetNodeId: target, diagnostic: event });
const spec = () => SkillSpecSchema.parse({ schemaVersion: 1, scope: { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: "a".repeat(64) },
  trigger: { actionKind: "input_text", errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED" }, entryConditions: [],
  program: { entry: 0, nodes: [
    { kind: "step", operation: { op: "inspect_changed_labels" }, next: 1 },
    { kind: "step", operation: { op: "allow_unrelated_status_labels" }, next: 2 },
    { kind: "step", operation: { op: "input_requested_text", source: "current_task_requested_text" }, next: 3 },
    { kind: "end", outcome: "continue" },
  ] }, lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 60_000 });

test("native label evidence persists fixed flags and counts, never label identity or meaning", () => {
  const step = trace(), facts = factsFromTrace(step);
  assert.equal(step.executor, "node-v1");
  assert.equal(step.after.changedLabelCount, 1);
  assert.equal(step.after.changedLabelsPresent, "yes");
  assert.equal(facts.nativeContextChange, "yes");
  assert.equal(facts.labelOnlyContextChange, "yes", "structural evidence does not mean the label is semantically safe");
  for (const privateValue of [privateLabel, target, status, "private-session", "private.app", "new-private-label-value", "private.input", "TextView", "changedLabelNodeIds"])
    assert.equal(JSON.stringify([step, facts]).includes(privateValue), false, privateValue);
  const legacy = structuredClone(step);
  delete legacy.executor; delete legacy.after.changedLabelCount; delete legacy.after.changedLabelsPresent;
  assert.equal(TraceStepSchema.safeParse(legacy).success, true);
  assert.equal(factsFromTrace(legacy).nativeContextChange, "unknown");
  assert.equal(factsFromTrace(legacy).labelOnlyContextChange, "unknown");
});

test("malformed, incomplete and unmapped changed label evidence stays unknown", () => {
  for (const changedLabelNodeIds of [[], [status, status], [target, "unknown"], [42], Array.from({ length: 9 }, () => status), privateLabel]) {
    const compact = compactObservation({ ...after, changedLabelNodeIds });
    assert.equal(compact.changedLabelsPresent, "unknown");
    assert.equal(compact.changedLabelCount, 0);
  }
  for (const changed of [
    { ...after, truncated: true }, { ...after, snapshotId: undefined },
    { ...after, nodes: [...after.nodes, after.nodes[2]] }, { changedLabelNodeIds: [status] },
  ]) assert.equal(compactObservation(changed).changedLabelsPresent, "unknown");
  for (const diagnostic of [
    { ...event, executor: undefined }, { ...event, dispatchState: "sent" as const }, { ...event, acceptanceState: "unknown" as const },
    { ...event, reason: "NODE_CONTENT_CHANGED" as const }, { ...event, contextChange: undefined },
  ]) assert.equal(factsFromTrace(compactTrace({ index: 0, before, after, targetNodeId: target, diagnostic })).nativeContextChange, "unknown");
  for (const contextChange of [
    { ...event.contextChange!, changedNodes: 2 }, { ...event.contextChange!, targetMatched: false },
    { ...event.contextChange!, region: "target" as const }, { ...event.contextChange!, kind: "geometry" as const },
  ]) assert.equal(factsFromTrace(compactTrace({ index: 0, before, after, targetNodeId: target, diagnostic: { ...event, contextChange } })).labelOnlyContextChange, "no");
});

test("bounded label advice requires native proof and leaves semantic decisions to current evidence", () => {
  const facts = factsFromTrace(trace()), advice = compileSkill(spec(), facts).join("\n");
  assert.match(advice, /not evidence that ignoring it is safe/);
  assert.match(advice, /Never allow recipient, account, amount/);
  assert.match(advice, /never copy all changed IDs automatically/);
  assert.match(advice, /current-snapshot IDs as allowedLabelChanges/);
  assert.equal(advice.includes(status), false);
  for (const update of [
    { nativeContextChange: "unknown" as const }, { labelOnlyContextChange: "no" as const }, { changedLabelCount: 0 },
    { changedLabelsPresent: "unknown" as const }, { complete: "no" as const }, { contextChanged: "yes" as const }, { priorActionAccepted: "yes" as const },
  ]) {
    const refused = compileSkill(spec(), { ...facts, ...update }).join("\n");
    assert.match(refused, /Stop this recovery/);
    assert.doesNotMatch(refused, /pass those explicitly reviewed/);
    assert.doesNotMatch(refused, /pass the already user-requested text/);
  }
  assert.match(compileSkill({ ...spec(), trigger: { ...spec().trigger, actionKind: "scroll" } }, facts).join("\n"), /Stop this recovery/);
  for (const operation of [
    { op: "allow_unrelated_status_labels", nodeIds: [status] },
    { op: "allow_unrelated_status_labels", meaning: "safe" },
    { op: "inspect_changed_labels", allowAll: true },
  ]) assert.equal(SkillOperationSchema.safeParse(operation).success, false);
});

test("current native refusal activates advice once, subsequent read cannot reuse historical label identities", () => {
  for (const refresh of [false, true]) {
    const skill = spec();
    const session = new SkillSession({ skillSnapshot: [skill] }, skill.scope.hostVersion, skill.scope.modelProfile);
    session.record(event, before, after, target);
    if (refresh) session.record({ ...event, executor: undefined, actionKind: "get_ui_tree", outcome: "success", failureStage: "none", dispatchState: "not_applicable", acceptanceState: "not_applicable", effectState: "not_applicable", errorCode: "NONE", reason: "NONE", contextChange: undefined }, after, tree(3));
    const advice = session.consumeHints().join("\n");
    assert.equal(advice.includes("pass those explicitly reviewed"), !refresh);
    if (refresh) assert.match(advice, /Stop this recovery/);
    assert.deepEqual(session.consumeHints(), []);
  }
});
