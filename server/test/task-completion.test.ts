import assert from "node:assert/strict";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { completionEvidenceUnchanged, finishTaskTool, validateTaskCompletion, type FinishTaskRequest } from "../src/runtime/task-completion.js";

type Json = Record<string, any>;
const tree = (overrides: Json = {}): Json => ({ snapshotId: "fixture:2", truncated: false,
  nodes: [{ nodeId: "heading", text: "Synthetic destination", visible: true, enabled: true }], ...overrides });
const request = (overrides: Json = {}): Json => ({ status: "completed", answer: "已进入目标页面。", snapshotId: "fixture:2", evidenceNodeIds: ["heading"], ...overrides });
const schema = new AjvJsonSchemaValidator().getValidator<Json>(finishTaskTool.inputSchema);

test("finish_task accepts current native evidence without operating or asserting task semantics", () => {
  const args = request();
  assert.equal(schema(args).valid, true);
  assert.deepEqual(validateTaskCompletion(args, { result: { observation: tree() } }), { ok: true, request: args });
  // The validator checks references, not prose meaning: the runtime must not treat
  // this as an independent semantic oracle or drop its final continuity checks.
  assert.equal(validateTaskCompletion(request({ answer: "模型对任务的结论" }), tree()).ok, true);
});

test("blocked requires an explanation but no native or visual evidence", () => {
  const args = { status: "blocked", answer: "当前步骤需要用户手动确认。" };
  assert.equal(schema(args).valid, true);
  assert.deepEqual(validateTaskCompletion(args, undefined), { ok: true, request: args });
});

test("argument validation and the declared schema reject malformed completion requests", () => {
  const invalid: unknown[] = [null, [], request({ status: "success" }), request({ answer: " \n\t " }), request({ answer: "x".repeat(8001) }),
    request({ snapshotId: "" }), request({ snapshotId: undefined }), request({ evidenceNodeIds: undefined }),
    request({ evidenceNodeIds: [] }), request({ evidenceNodeIds: ["heading", "heading"] }), request({ evidenceNodeIds: [" "] }),
    request({ evidenceNodeIds: Array.from({ length: 17 }, (_, index) => `n${index}`) }), request({ extra: "not allowed" })];
  for (const value of invalid) {
    assert.equal(schema(value).valid, false);
    const result = validateTaskCompletion(value, tree());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "INVALID_FINISH_TASK");
  }
});

test("stale, nonexistent and ambiguous evidence is refused without changing the current observation", () => {
  const current = tree();
  for (const args of [request({ snapshotId: "fixture:1" }), request({ evidenceNodeIds: ["absent"] })]) {
    const result = validateTaskCompletion(args, current);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "COMPLETION_EVIDENCE_INVALID");
  }
  assert.equal(validateTaskCompletion(request(), tree({ nodes: [current.nodes[0], current.nodes[0]] })).ok, false);
  const ambiguous = validateTaskCompletion(request(), tree({ nodes: [current.nodes[0], { ...current.nodes[0], nodeId: "other-heading" }] }));
  assert.equal(ambiguous.ok, false, "distinct nodeIds with identical evidence are rejected before the final read");
  if (!ambiguous.ok) {
    assert.equal(ambiguous.code, "COMPLETION_EVIDENCE_INVALID");
    assert.match(ambiguous.message, /distinguishable evidence nodes/);
  }
  assert.equal(current.snapshotId, "fixture:2");
  assert.equal(current.nodes.length, 1);
});

test("completed does not accept partial, unavailable, settling or screenshot-only observations", () => {
  const semantic = { observationContract: "semantic-v1", quality: { status: "usable", reason: "accessible_content", actionableCount: 0, readableCount: 1 } };
  for (const observation of [undefined, { snapshotId: "fixture:2", elements: tree().nodes }, { kind: "screenshot", captureId: "visual:1" },
    tree({ truncated: true }), tree({ truncated: undefined }), tree({ nodes: [] }),
    tree({ ...semantic, quality: { status: "unavailable", reason: "no_accessible_content", actionableCount: 0, readableCount: 0 } }),
    tree({ ...semantic, readiness: { status: "settling", reason: "deadline", samples: 1, waitedMs: 0 } })]) {
    assert.equal(validateTaskCompletion(request(), observation).ok, false);
  }
  assert.equal(validateTaskCompletion(request(), tree(semantic)).ok, true);
});

test("evidence nodes must be visible, non-sensitive and meaningful", () => {
  for (const node of [
    { text: "destination", visible: false }, { text: "secret", password: true },
    { text: "secret", dataSensitive: true }, { text: "secret", accessibilityDataSensitive: true },
    { text: " ", contentDescription: "\t" }, { clickable: true, enabled: false }, { resourceId: "fixture:id/layout" },
  ]) assert.equal(validateTaskCompletion(request(), tree({ nodes: [{ nodeId: "heading", ...node }] })).ok, false);
  for (const node of [{ text: "Destination" }, { contentDescription: "Selected destination" }, { clickable: true, enabled: true }]) {
    assert.equal(validateTaskCompletion(request(), tree({ nodes: [{ nodeId: "heading", ...node }] })).ok, true);
  }
});

test("every cited node must be valid and returned evidence references are copied", () => {
  const args = request();
  const result = validateTaskCompletion(args, tree());
  args.evidenceNodeIds.push("absent");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.request.evidenceNodeIds, ["heading"]);
  assert.equal(validateTaskCompletion(args, tree()).ok, false);
});

test("final evidence rebinds across new node handles and ignores unrelated counters", () => {
  const cited = tree().nodes[0];
  const before = tree({ nodes: [cited, { nodeId: "clock", text: "Counter 1", visible: true }] });
  const after = tree({ snapshotId: "fixture:3", nodes: [
    { ...cited, nodeId: "new-heading", bounds: [10, 20, 300, 100] },
    { nodeId: "new-clock", text: "Counter 2", visible: true },
  ] });
  assert.equal(completionEvidenceUnchanged(request() as FinishTaskRequest, before, after), true);
});

test("final evidence rejects changed cited content, identity and control state", () => {
  const cited = { ...tree().nodes[0], resourceId: "fixture:id/item", className: "android.widget.CheckBox", checkable: true, checked: false, selected: false };
  const before = tree({ nodes: [cited] });
  for (const change of [{ text: "Different destination" }, { contentDescription: "Different account" },
    { resourceId: "fixture:id/other" }, { className: "android.widget.Button" }, { checked: true },
    { checked: undefined }, { selected: true }, { enabled: false }]) {
    const after = tree({ snapshotId: "fixture:3", nodes: [{ ...cited, nodeId: "new-heading", ...change }] });
    assert.equal(completionEvidenceUnchanged(request() as FinishTaskRequest, before, after), false);
  }
});

test("final evidence rejects missing, ambiguous, hidden, protected and incomplete matches", () => {
  const before = tree();
  const cited = before.nodes[0];
  for (const after of [tree({ nodes: [] }), tree({ nodes: [{ ...cited, nodeId: "a" }, { ...cited, nodeId: "b" }] }),
    tree({ nodes: [{ ...cited, visible: false }] }), tree({ nodes: [{ ...cited, password: true }] }),
    tree({ truncated: true }), { snapshotId: "fixture:3", elements: [cited] }]) {
    assert.equal(completionEvidenceUnchanged(request() as FinishTaskRequest, before, after), false);
  }
  assert.equal(completionEvidenceUnchanged(request() as FinishTaskRequest,
    tree({ nodes: [cited, { ...cited, nodeId: "duplicate" }] }), tree()), false);
  assert.equal(completionEvidenceUnchanged({ status: "blocked", answer: "需要手动操作" }, before, tree()), false);
});
