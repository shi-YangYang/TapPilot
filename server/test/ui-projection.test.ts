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

test("partial find results keep every match and missing parents are not presented as observed targets", () => {
  const projected = projectToolResult({ snapshotId: "synthetic:2", packageName: "synthetic.fixture", elements: [node("n9", "unreturned", { resourceId: "synthetic.fixture:id/wrapper" })], truncated: true, changed: true, timedOut: false, matched: true }) as Json;
  assert.equal(projected.elements.length, 1);
  assert.equal(projected.elements[0].nodeId, "n9");
  assert.equal(projected.elements[0].parentId, undefined);
  assert.equal(projected.truncated, true);
  assert.equal(projected.timedOut, false);
  assert.equal(projected.matched, true);
});

test("tool envelopes retain host outcomes and errors while omitting telemetry, unknown metadata and repeated targets", () => {
  const target = node("n3", "n1", { text: "Old synthetic UI label", clickable: true });
  const source = {
    ok: true, result: { action: { action: "click", accepted: true, verificationRequired: true, target, actedNode: target, ancestorHops: 0 },
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
