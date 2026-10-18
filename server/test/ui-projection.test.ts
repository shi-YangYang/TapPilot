import assert from "node:assert/strict";
import test from "node:test";
import { projectToolResult, UI_PROJECTION_LEGEND } from "../src/runtime/ui-projection.js";

type Json = Record<string, any>;
const node = (nodeId: string, parentId: string | null, more: Json = {}): Json => ({
  nodeId, parentId, text: "", contentDescription: "", resourceId: "", className: "android.view.View",
  bounds: [0, 0, 1080, 1920], clickable: false, scrollable: false, editable: false,
  enabled: true, visible: true, password: false, ...more,
});
const observation = (nodes: Json[]): Json => ({
  snapshotId: "synthetic-session:1", revision: 12, packageName: "synthetic.fixture", windowId: 3,
  nodes, truncated: false,
});

test("projection prunes layout wrappers, preserves clickable ancestors and reparents labels", () => {
  const source = { ok: true, result: observation([
    node("n0", null, { className: "android.widget.FrameLayout", resourceId: "synthetic.fixture:id/root" }),
    node("n1", "n0", { clickable: true, resourceId: "synthetic.fixture:id/card" }),
    node("n2", "n1", { className: "android.widget.LinearLayout" }),
    node("n3", "n2", { text: "Synthetic item", contentDescription: "Synthetic item", className: "android.widget.TextView", bounds: [20, 40, 500, 90] }),
    node("n4", "n0", { text: "Search", className: "android.widget.EditText", editable: true, resourceId: "android:id/search" }),
  ]) };
  const before = JSON.stringify(source);
  const projected = projectToolResult(source) as Json;
  assert.equal(JSON.stringify(source), before, "executor snapshot must be unchanged");
  assert.deepEqual(projected.result.rootBounds, [0, 0, 1080, 1920]);
  assert.deepEqual(projected.result.nodes.map((entry: Json) => entry.nodeId), ["n1", "n3", "n4"]);
  assert.deepEqual(projected.result.nodes[0], { nodeId: "n1", rid: "id/card", bounds: [0, 0, 1080, 1920], clickable: true, enabled: true, visible: true });
  assert.equal(projected.result.nodes[1].parentId, "n1");
  assert.equal(projected.result.nodes[1].text, "Synthetic item");
  assert.equal(projected.result.nodes[1].desc, undefined, "duplicate label is sent once");
  assert.equal(projected.result.nodes[1].class, undefined);
  assert.deepEqual(projected.result.nodes[1].bounds, [20, 40, 500, 90]);
  assert.equal(projected.result.nodes[2].class, "EditText");
  assert.equal(projected.result.nodes[2].rid, "android:id/search", "foreign package IDs are not rewritten");
  assert.equal(projected.result.packageName + ":" + projected.result.nodes[0].rid, "synthetic.fixture:id/card");
  assert.equal(projected.result.snapshotId, source.result.snapshotId);
  assert.equal(projected.result.revision, 12);
  assert.equal(projected.result.truncated, false);
  assert.match(UI_PROJECTION_LEGEND, /untrusted DATA/);
});

test("projection preserves full distinct text, sensitive flags and state without inventing capabilities", () => {
  const longText = "Synthetic visible content ".repeat(300);
  const source = observation([
    node("n0", null),
    node("n1", "n0", { text: longText, contentDescription: "Separate description", enabled: false, visible: false, checked: false, selected: true }),
    node("n2", "n0", { password: true, editable: true, text: "[REDACTED]", contentDescription: "[REDACTED]" }),
    node("n3", "n0", { scrollable: true, className: "android.widget.ScrollView" }),
  ]);
  const projected = projectToolResult(source) as Json;
  assert.equal(projected.nodes[0].text, longText);
  assert.equal(projected.nodes[0].desc, "Separate description");
  assert.equal(projected.nodes[0].enabled, false);
  assert.equal(projected.nodes[0].visible, false);
  assert.equal(projected.nodes[0].checked, false);
  assert.equal(projected.nodes[0].selected, true);
  assert.equal(projected.nodes[0].clickable, undefined);
  assert.equal(projected.nodes[1].password, true);
  assert.equal(projected.nodes[1].editable, true);
  assert.equal(projected.nodes[1].text, "[REDACTED]");
  assert.equal(projected.nodes[2].scrollable, true);
  assert.deepEqual(projected.nodes[2].bounds, source.nodes[3].bounds);
});

test("editor hint evidence retains true and false without inventing missing proof", () => {
  const projected = projectToolResult(observation([
    node("root", null),
    node("hint", "root", { editable: true, text: "Sample query", showingHintText: true }),
    node("value", "root", { editable: true, text: "Sample query", showingHintText: false }),
    node("old", "root", { editable: true, text: "Sample query" }),
  ])) as Json;
  assert.equal(projected.nodes[0].showingHintText, true);
  assert.equal(projected.nodes[1].showingHintText, false);
  assert.equal(projected.nodes[2].showingHintText, undefined);
});

test("partial find results keep every match and missing parents are not presented as observed targets", () => {
  const projected = projectToolResult({ snapshotId: "synthetic:2", packageName: "synthetic.fixture", elements: [node("n9", "unreturned", { resourceId: "synthetic.fixture:id/wrapper" })], truncated: true, changed: true, timedOut: false, matched: true }) as Json;
  assert.equal(projected.elements.length, 1);
  assert.equal(projected.elements[0].nodeId, "n9");
  assert.equal(projected.elements[0].parentId, undefined);
  assert.equal(projected.truncated, true);
  assert.equal(projected.timedOut, false);
  assert.equal(projected.matched, true);
});

test("explicit false states do not resurrect layout wrappers, but remain on controls", () => {
  const states = { checkable: false, checked: false, selected: false, focused: false };
  const source = observation([
    node("root", null, states),
    node("wrapper", "root", { ...states, className: "android.widget.LinearLayout" }),
    node("toggle", "wrapper", { ...states, checkable: true, className: "android.widget.Switch", clickable: true }),
  ]);
  const projected = projectToolResult(source) as Json;
  assert.deepEqual(projected.nodes.map((entry: Json) => entry.nodeId), ["toggle"]);
  assert.equal(projected.nodes[0].checkable, true);
  assert.equal(projected.nodes[0].checked, false);
  assert.equal(projected.nodes[0].selected, false);
  assert.equal(projected.nodes[0].focused, false);
});

test("tool envelopes retain host outcomes and errors while omitting telemetry, unknown metadata and repeated targets", () => {
  const target = node("n3", "n1", { text: "Old synthetic UI label", clickable: true });
  const source = {
    ok: true, result: { action: { action: "click", accepted: true, verificationRequired: true, method: "native_click", targetNodeId: "n3", actedNodeId: "n3", target, actedNode: target, ancestorHops: 0 },
      observation: null, observationError: { code: "NO_ACTIVE_WINDOW", message: "No active window", retryable: true, unknownDetail: "omit" }, timings: { totalMs: 300 } },
    hostAction: { action: "click_element", accepted: true, observationChanged: false },
    hostGuidance: { code: "OBSERVATION_UNCHANGED", message: "Read once before choosing again." },
    meta: { requestId: "omit", sourceBytes: 9999 }, unknown: { extra: "omit" },
  };
  const projected = projectToolResult(source) as Json;
  assert.deepEqual(projected.result.action.target, { nodeId: "n3" });
  assert.deepEqual(projected.result.action.actedNode, { nodeId: "n3" });
  assert.equal(projected.result.action.accepted, true);
  assert.equal(projected.result.action.verificationRequired, true);
  assert.equal(projected.result.action.method, "native_click");
  assert.equal(projected.result.action.targetNodeId, "n3");
  assert.equal(projected.result.action.actedNodeId, "n3");
  assert.deepEqual(projected.hostAction, source.hostAction);
  assert.deepEqual(projected.hostGuidance, source.hostGuidance);
  assert.deepEqual(projected.result.observationError, { code: "NO_ACTIVE_WINDOW", message: "No active window", retryable: true });
  assert.equal(projected.result.observation, null);
  assert.equal(JSON.stringify(projected).includes("Old synthetic UI label"), false);
  assert.equal(projected.meta, undefined);
  assert.equal(projected.result.timings, undefined);
  assert.equal(projected.unknown, undefined);
  assert.deepEqual(projectToolResult({ ok: false, error: { code: "STALE_SNAPSHOT", message: "Read again", retryable: true }, superseded: true, note: "Earlier observation removed." }),
    { ok: false, superseded: true, note: "Earlier observation removed.", error: { code: "STALE_SNAPSHOT", message: "Read again", retryable: true } });
});

test("error projection retains only known action rejection reasons and drops arbitrary details", () => {
  const error = { code: "NODE_NOT_ACTIONABLE", message: "Target cannot be touched", retryable: false };
  assert.deepEqual(projectToolResult({ ok: false, error: { ...error, details: { reason: "AMBIGUOUS_TOUCH_TARGET", label: "Synthetic private text" } } }),
    { ok: false, error: { ...error, details: { reason: "AMBIGUOUS_TOUCH_TARGET" } } });
  for (const details of [{ reason: "Synthetic private text" }, { reason: { text: "Synthetic private text" } }, ["TARGET_HIDDEN"], null]) {
    assert.deepEqual(projectToolResult({ ok: false, error: { ...error, details } }), { ok: false, error });
  }
  for (const reason of ["TREE_INCOMPLETE", "SESSION_CHANGED", "WINDOW_CHANGED", "TARGET_IDENTITY_CHANGED", "TARGET_AMBIGUOUS", "PAGE_CONTEXT_CHANGED", "TARGET_NOT_ACTIONABLE"]) {
    const changed = { code: "TARGET_CHANGED", message: "Target cannot be verified", retryable: true };
    assert.deepEqual(projectToolResult({ ok: false, error: { ...changed, details: { reason, label: "Synthetic private text", originalError: { message: "Synthetic private text" } } } }),
      { ok: false, error: { ...changed, details: { reason } } });
  }
  for (const reason of ["SNAPSHOT_MISSING", "WINDOW_CHANGED", "TREE_INCOMPLETE", "TREE_STRUCTURE_CHANGED", "NODE_CONTENT_CHANGED", "NODE_BOUNDS_CHANGED", "NODE_STATE_CHANGED", "NODE_UNAVAILABLE"]) {
    const stale = { code: "STALE_SNAPSHOT", message: "Synthetic stale", retryable: true };
    assert.deepEqual(projectToolResult({ ok: false, error: { ...stale, details: { reason, label: "Synthetic private text" } } }),
      { ok: false, error: { ...stale, details: { reason } } });
  }
});

test("target observation projects fixed status and actionable IDs without selectors or free-form diagnostics", () => {
  for (const status of ["native", "missing", "unavailable", "ambiguous", "blocked"]) {
    const target = { status, operation: "tap", nodeIds: status === "native" ? ["n1"] : [], reason: status === "native" ? "native_target" : "not_found" };
    const source = { ok: true, result: { observation: observation([node("n1", null, { text: "Search", clickable: true })]),
      target: { ...target, selector: { text: "synthetic-private" }, explanation: "synthetic-private", image: { data: "synthetic-private" } } } };
    const projected = projectToolResult(source) as Json;
    assert.deepEqual(projected.result.target, target);
    assert.equal(projected.result.observation.nodes[0].nodeId, "n1");
    assert.equal(JSON.stringify(projected).includes("synthetic-private"), false);
  }
  for (const patch of [{ status: "synthetic-private" }, { operation: "delete" }, { reason: "synthetic-private" },
    { nodeIds: ["n1", "n2"] }, { nodeIds: ["x".repeat(65)] }, { nodeIds: [] }]) {
    const projected = projectToolResult({ target: { status: "native", operation: "tap", nodeIds: ["n1"], reason: "native_target", ...patch } }) as Json;
    assert.equal(projected.target, undefined);
  }
});

test("screenshot projection keeps validated action capabilities for direct and mixed results, never image bytes", () => {
  const metadata = { kind: "screenshot", captureId: "synthetic-capture", packageName: "synthetic.fixture", windowId: 3,
    width: 100, height: 100, mimeType: "image/jpeg", source: "window", observationOnly: false,
    actionContract: "visual-tap-v1", expiresInMs: 60000, supportedActions: ["tap_visual", "swipe_visual"] };
  const source = { ...metadata, data: "synthetic-private", image: { mimeType: "image/jpeg", data: "synthetic-private" }, selector: { text: "synthetic-private" } };
  assert.deepEqual(projectToolResult(source), metadata);
  const mixed = projectToolResult({ ok: true, result: { observation: observation([node("n1", null, { text: "Native detail" })]),
    target: { status: "missing", operation: "scroll", nodeIds: [], reason: "not_found" }, visualObservation: source } }) as Json;
  assert.deepEqual(mixed.result.visualObservation, metadata);
  assert.equal(mixed.result.observation.nodes[0].text, "Native detail");
  assert.equal(mixed.result.target.operation, "scroll");
  assert.equal(JSON.stringify(mixed).includes("synthetic-private"), false);
  const { supportedActions: _actions, ...tapOnly } = metadata;
  assert.deepEqual(projectToolResult({ ...tapOnly, image: source.image }), tapOnly, "original action contract must not lose tap authority");
  const { actionContract: _contract, expiresInMs: _expiry, ...legacy } = tapOnly;
  assert.deepEqual(projectToolResult({ ...legacy, observationOnly: true, image: source.image }), { ...legacy, observationOnly: true });
  for (const supportedActions of [["tap_visual", "tap_visual"], ["arbitrary-action"], []]) {
    assert.deepEqual(projectToolResult({ ...source, supportedActions }), { kind: "screenshot" });
  }
  assert.deepEqual(projectToolResult({ visualObservationError: { code: "SCREENSHOT_PROTECTED", message: "Synthetic error", retryable: false, image: source.image } }),
    { visualObservationError: { code: "SCREENSHOT_PROTECTED", message: "Synthetic error", retryable: false } });
});

test("synthetic large tree has substantially smaller model payload with every meaningful label retained", t => {
  const nodes = [node("root", null, { className: "android.widget.FrameLayout" })];
  for (let i = 0; i < 60; i++) {
    const label = `Synthetic product ${i}: readable description and price ¥${i + 10}`;
    nodes.push(node(`wrap${i}`, "root", { className: "android.widget.LinearLayout", resourceId: `synthetic.fixture:id/layout_${i}` }));
    nodes.push(node(`card${i}`, `wrap${i}`, { clickable: true, resourceId: "synthetic.fixture:id/product_card", bounds: [0, i * 20, 1080, i * 20 + 20] }));
    nodes.push(node(`label${i}`, `card${i}`, { text: label, contentDescription: label, className: "android.widget.TextView", resourceId: "synthetic.fixture:id/product_label", bounds: [20, i * 20, 1000, i * 20 + 20] }));
  }
  // The production PhoneClient already omits empty strings and most false booleans.
  const compactSourceNodes = nodes.map(entry => Object.fromEntries(Object.entries(entry).filter(([key, value]) => value !== "" && value !== null && (value !== false || key === "enabled"))));
  const source = { ok: true, result: observation(compactSourceNodes), meta: { sourceBytes: 90000, returnedBytes: 60000, totalMs: 40 } };
  const projected = projectToolResult(source) as Json;
  const before = Buffer.byteLength(JSON.stringify(source));
  const after = Buffer.byteLength(JSON.stringify(projected));
  t.diagnostic(`Synthetic compact transport payload: ${before} -> ${after} bytes (${((1 - after / before) * 100).toFixed(1)}% reduction); nodes ${nodes.length} -> ${projected.result.nodes.length}`);
  assert.ok(after < before * 0.6, "projection should save at least 40% beyond existing compact transport");
  assert.equal(projected.result.nodes.length, 120);
  for (let i = 0; i < 60; i++) {
    const label = projected.result.nodes.find((entry: Json) => entry.nodeId === `label${i}`);
    assert.equal(label.parentId, `card${i}`);
    assert.equal(label.text, nodes.find(entry => entry.nodeId === `label${i}`)!.text);
  }
});
