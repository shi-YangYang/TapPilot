import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { observedLabelChanges } from "../src/skills/label-observation.js";
import { SkillSession } from "../src/skills/runtime.js";
import { SkillSpecSchema, SKILL_POLICY_REVISION, skillHash } from "../src/skills/schema.js";
import { DiagnosticEventSchema } from "../src/diagnostics/schema.js";
import { compactUi } from "../src/client-tools.js";

type Json = Record<string, any>;
const packageName = "synthetic.prevention.fixture";
const scope = { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: "a".repeat(64),
  appDigest: createHash("sha256").update(packageName).digest("hex") };
const node = (nodeId: string, parentId: string | null, text = ""): Json => ({ nodeId, parentId, text, contentDescription: "",
  className: "android.widget.TextView", resourceId: `synthetic:id/${nodeId}`, bounds: [0, 0, 200, 30],
  clickable: false, scrollable: false, editable: false, enabled: true, password: false,
  checkable: false, checked: false, selected: false, focused: false, visible: true });
const tree = (revision = 1): Json => ({ snapshotId: `session:${revision}`, revision, packageName, windowId: 1, truncated: false,
  nodes: [{ ...node("root", null), className: "android.widget.LinearLayout", bounds: [0, 0, 200, 400], focused: true },
    { ...node("status", "root", `同步进度：${revision}`), bounds: [0, 40, 200, 70] },
    { ...node("recipient", "root", "收件人甲"), bounds: [0, 80, 200, 110] },
    { ...node("editor", "root"), className: "android.widget.EditText", bounds: [0, 120, 200, 160], editable: true, clickable: true }] });
const spec = () => SkillSpecSchema.parse({ schemaVersion: 1, scope,
  trigger: { errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", actionKind: "input_text" },
  entryConditions: [{ fact: "priorActionAccepted", test: "eq", value: "no" }],
  program: { entry: 0, nodes: [{ kind: "step", operation: { op: "inspect", aspect: "context" }, next: 1 }, { kind: "end", outcome: "continue" }] },
  prevention: { entryConditions: [{ fact: "observedLabelChanges", test: "eq", value: "yes" }], program: { entry: 0, nodes: [
    { kind: "step", operation: { op: "inspect_changed_labels" }, next: 1 },
    { kind: "step", operation: { op: "allow_unrelated_status_labels" }, next: 2 }, { kind: "end", outcome: "continue" }] } },
  lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 100_000 });
const read = DiagnosticEventSchema.parse({ schemaVersion: 1, eventType: "tool_result", runId: "00000000-0000-4000-8000-000000000001", timestamp: 1,
  stepIndex: 0, versions: { host: scope.hostVersion }, actionKind: "get_ui_tree", outcome: "success", failureStage: "none",
  dispatchState: "not_applicable", acceptanceState: "not_applicable", effectState: "not_applicable", errorCode: "NONE", reason: "NONE" });

test("two observations report current passive label IDs without assigning business meaning", () => {
  const before = tree(), after = tree(2);
  assert.deepEqual(observedLabelChanges(before, after), ["status"]);
  assert.deepEqual(observedLabelChanges(compactUi(before), compactUi(after)), ["status"], "actual phone-client omission rules retain the same physical evidence");
  after.nodes[2].text = "收件人乙";
  assert.deepEqual(observedLabelChanges(before, after), ["status", "recipient"], "changed business content is evidence to inspect, never automatically allowed");
  after.revision = before.revision;
  assert.deepEqual(observedLabelChanges(before, after), ["status", "recipient"], "missing content events do not negate a fresh physical difference");
  assert.equal(before.nodes[2].text, "收件人甲", "comparison never mutates a source tree");
});

test("roles, geometry, topology, identity, session or completeness changes invalidate label-only evidence", () => {
  const changes = [
    (t: Json) => { t.nodes[1].clickable = true; },
    (t: Json) => { t.nodes[1].editable = true; },
    (t: Json) => { t.nodes[1].password = true; },
    (t: Json) => { t.nodes[1].visible = false; },
    (t: Json) => { t.nodes[3].focused = true; },
    (t: Json) => { t.nodes[1].bounds[1]++; },
    (t: Json) => { t.nodes[1].resourceId = "synthetic:id/replaced"; },
    (t: Json) => { t.nodes[1].nodeId = "replacement"; },
    (t: Json) => { t.nodes[1].parentId = "editor"; },
    (t: Json) => { t.nodes[1].labelFor = "editor"; },
    (t: Json) => { t.nodes[1].contextProtected = true; },
    (t: Json) => { t.nodes.reverse(); },
    (t: Json) => { t.snapshotId = "different:2"; },
    (t: Json) => { t.windowId++; },
    (t: Json) => { t.packageName = "another.app"; },
    (t: Json) => { t.truncated = true; },
  ];
  for (const change of changes) { const after = tree(2); change(after); assert.equal(observedLabelChanges(tree(), after), undefined); }
  const first = tree(), second = tree(2);
  first.nodes[0].clickable = second.nodes[0].clickable = true;
  assert.equal(observedLabelChanges(first, second), undefined, "passive text under a button is interactive content");
  assert.equal(observedLabelChanges(tree(), tree()), undefined, "one snapshot is not two observations");
});

test("the physical comparison is bounded to eight changed leaves", () => {
  const before = tree(), after = tree(2);
  for (let index = 0; index < 8; index++) {
    before.nodes.push(node(`extra-${index}`, "root", "old")); after.nodes.push(node(`extra-${index}`, "root", "new"));
  }
  assert.equal(observedLabelChanges(before, after), undefined);
});

test("initial read/wait/read prepares one hint with no invented native refusal", () => {
  const used: string[][] = [], traces: Json[] = [], episodes: unknown[] = [];
  const candidate = spec();
  candidate.prevention!.entryConditions.push({ fact: "focusChanged", test: "eq", value: "no" });
  const session = new SkillSession({ skillSnapshot: [candidate], onSkillUsed: hashes => { used.push([...hashes]); },
    onSkillTrace: step => { traces.push(step); }, onFailureEpisode: episode => { episodes.push(episode); } }, scope.hostVersion, scope.modelProfile);
  const before = tree(), after = tree(2);
  session.record(read, undefined, before);
  assert.equal(session.hasPreventiveCandidate(before), true);
  assert.equal(session.hasPreventiveCandidate(before), false, "sampling is requested once");
  session.record({ ...read, actionKind: "wait_for_ui_change" }, before, undefined);
  session.record(read, undefined, after);
  assert.equal(session.preparePrevention(before, after), true);
  assert.deepEqual(used, []);
  const advice = session.consumeHints().join("\n");
  assert.match(advice, /recipient|business/i);
  assert.deepEqual(used, [[skillHash(candidate)]]);
  assert.deepEqual(session.consumeHints(), []);
  assert.ok(traces.every(step => step.errorCode === "NONE" && step.executor === undefined));
  session.finish("completed"); assert.deepEqual(episodes, [], "successful sampling cannot fabricate a failure episode");
});

test("prevention is scoped and a prepared hint is invalidated by intervening tools or context", () => {
  const candidate = spec(), before = tree(), after = tree(2);
  const otherApp = new SkillSession({ skillSnapshot: [candidate] }, scope.hostVersion, scope.modelProfile);
  const elsewhere = { ...before, packageName: "different.app" };
  otherApp.record(read, undefined, elsewhere); assert.equal(otherApp.hasPreventiveCandidate(elsewhere), false);
  for (const kind of ["action", "context", "later_read"] as const) {
    const session = new SkillSession({ skillSnapshot: [candidate] }, scope.hostVersion, scope.modelProfile);
    session.record(read, undefined, before); assert.equal(session.hasPreventiveCandidate(before), true);
    session.record(read, before, after); assert.equal(session.preparePrevention(before, after), true);
    if (kind === "action") session.record({ ...read, actionKind: "input_text", dispatchState: "sent", acceptanceState: "accepted", effectState: "changed" }, after, after);
    else session.record(read, after, kind === "context" ? { ...tree(3), windowId: 2 } : tree(3));
    assert.deepEqual(session.consumeHints(), []);
    assert.equal(session.hasPreventiveCandidate(tree(3)), false);
  }
});

test("each accepted mutation opens one comparison from its after-state and can reuse the same skill", () => {
  const candidate = spec(), used: string[][] = [];
  const session = new SkillSession({ skillSnapshot: [candidate], onSkillUsed: hashes => { used.push([...hashes]); } }, scope.hostVersion, scope.modelProfile);
  const before = tree(), first = tree(2);
  session.record(read, undefined, before); assert.equal(session.hasPreventiveCandidate(before), true);
  session.record(read, before, first); assert.equal(session.preparePrevention(before, first), true);
  assert.ok(session.consumeHints().length);
  const afterMutation = tree(3); afterMutation.nodes[3].text = "task input";
  session.record({ ...read, actionKind: "input_text", dispatchState: "sent", acceptanceState: "accepted", effectState: "changed" }, first, afterMutation);
  assert.equal(session.hasPreventiveCandidate(afterMutation), true);
  assert.equal(session.hasPreventiveCandidate(afterMutation), false);
  session.record({ ...read, actionKind: "wait_for_ui_change" }, afterMutation, undefined);
  const compared = tree(4); compared.nodes[3].text = "task input";
  session.record(read, undefined, compared);
  assert.equal(session.preparePrevention(first, compared), false, "pre-action input changes cannot supply label-only evidence");
  assert.equal(session.preparePrevention(afterMutation, compared), true);
  assert.ok(session.consumeHints().length);
  assert.deepEqual(used, [[skillHash(candidate)], [skillHash(candidate)]], "every actual hint use is observable even for the same hash");
  assert.equal(session.hasPreventiveCandidate(compared), false, "ordinary reads do not open another sampling window");
});

test("refused, uncertain, partial and cross-context mutations cannot open prevention sampling", () => {
  const accepted = { ...read, actionKind: "input_text" as const, dispatchState: "sent" as const,
    acceptanceState: "accepted" as const, effectState: "changed" as const };
  const variants = [
    { event: { ...accepted, outcome: "failure", errorCode: "TARGET_CHANGED", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown" } },
    { event: { ...accepted, dispatchState: "unknown" } },
    { event: { ...accepted, acceptanceState: "unknown" } },
    { event: { ...accepted, effectState: "unknown" } },
    { after: { ...tree(2), truncated: true } },
    { after: { ...tree(2), snapshotId: "another-session:2" } },
    { after: { ...tree(2), windowId: 2 } },
    { after: { ...tree(2), packageName: "another.app" } },
    { after: tree() },
  ];
  for (const variant of variants) {
    const session = new SkillSession({ skillSnapshot: [spec()] }, scope.hostVersion, scope.modelProfile);
    const before = tree(), after = variant.after ?? tree(2);
    session.record(read, undefined, before); session.consumeHints();
    session.record(DiagnosticEventSchema.parse(variant.event ?? accepted), before, after);
    assert.equal(session.hasPreventiveCandidate(after), false);
    session.record(read, after, tree(3));
    assert.equal(session.hasPreventiveCandidate(tree(3)), false, "a refresh cannot launder an unsuccessful action into a sampling window");
  }
});

test("repeated successful actions cannot exceed three distinct preventive skills per task", () => {
  const candidates = [4, 5, 6, 7].map(count => {
    const value = spec(); value.prevention!.entryConditions.push({ fact: "nodeCount", test: "eq", value: count }); return value;
  });
  const used: string[][] = [];
  const session = new SkillSession({ skillSnapshot: candidates, onSkillUsed: hashes => { used.push([...hashes]); } }, scope.hostVersion, scope.modelProfile);
  const sized = (revision: number, count: number) => { const value = tree(revision); while (value.nodes.length < count) value.nodes.push(node(`extra-${value.nodes.length}`, "root")); return value; };
  let previous = sized(1, 4);
  session.record(read, undefined, previous);
  for (let index = 0; index < 4; index++) {
    const baseline = index ? sized(index * 2 + 1, index + 4) : previous;
    if (index) session.record({ ...read, actionKind: "input_text", dispatchState: "sent", acceptanceState: "accepted", effectState: "changed" }, previous, baseline);
    assert.equal(session.hasPreventiveCandidate(baseline), true, "a previously used skill may still need its conditions checked");
    const current = sized(index * 2 + 2, index + 4);
    session.record(read, baseline, current);
    assert.equal(session.preparePrevention(baseline, current), index < 3);
    assert.equal(session.consumeHints().length > 0, index < 3);
    previous = current;
  }
  assert.equal(new Set(used.flat()).size, 3);
});

test("prevention cannot infer rejected execution or an editable target before any action", () => {
  const candidate = spec();
  candidate.prevention!.entryConditions = [{ fact: "priorActionAccepted", test: "eq", value: "no" }];
  const session = new SkillSession({ skillSnapshot: [candidate] }, scope.hostVersion, scope.modelProfile);
  session.record(read, undefined, tree()); assert.equal(session.hasPreventiveCandidate(tree()), true);
  session.record(read, tree(), tree(2)); assert.equal(session.preparePrevention(tree(), tree(2)), false);
  assert.deepEqual(session.consumeHints(), []);
});
