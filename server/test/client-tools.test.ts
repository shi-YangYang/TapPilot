import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { compactUi, createPhoneClient } from "../src/client-tools.js";
import { ToolController } from "../src/tools.js";
import { snapshot } from "./helpers.js";

const next = { ...snapshot, snapshotId: "session:2", revision: 2 };
function response(result: unknown) { return { id: "synthetic", ok: true, result, meta: { durationMs: 1 } }; }
const target = { snapshotId: snapshot.snapshotId, nodeId: "n0" };

test("combined tool validates nested arguments, retains manual approval and remembers returned observation", async () => {
  const calls: string[] = [];
  const bridge: PhoneBridge = { close: async () => {}, call: async (method) => {
    calls.push(method);
    return response(method === "get_ui_tree" ? snapshot : { action: { accepted: true }, observation: next });
  } };
  const manual = new ToolController(bridge, new Adb(), new ApprovalQueue());
  try {
    await manual.invoke("get_ui_tree", {});
    const blocked = (await manual.invoke("act_and_observe", { action: "click_element", arguments: target })).structuredContent!;
    assert.equal((blocked.error as any).code, "CONFIRMATION_REQUIRED");
    assert.deepEqual(calls, ["get_ui_tree"]);
  } finally { await manual.close(); }
  const controller = new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted");
  try {
    await controller.invoke("get_ui_tree", {});
    const invalid = (await controller.invoke("act_and_observe", { action: "click_element", arguments: { ...target, approved: true } })).structuredContent!;
    assert.equal((invalid.error as any).code, "INVALID_ARGUMENT");
    assert.equal((await controller.invoke("act_and_observe", { action: "click_element", arguments: target })).structuredContent!.ok, true);
    assert.equal((await controller.invoke("click_element", { ...target, snapshotId: next.snapshotId })).structuredContent!.ok, true);
  } finally { await controller.close(); }
});

test("client uses one phone RPC per action/observe, reduces bytes, and cannot replay an observation failure", async () => {
  const calls: string[] = [];
  let failedObservation = false;
  const bridge: PhoneBridge = { close: async () => {}, call: async (method, _args, _timeout, gate) => {
    gate?.(); calls.push(method);
    return response(method === "get_ui_tree" ? snapshot : failedObservation
      ? { action: { accepted: true }, observationError: { code: "NO_ACTIVE_WINDOW", message: "Synthetic transition" } }
      : { action: { accepted: true }, observation: next, timings: { totalMs: 2 } });
  } };
  const client = createPhoneClient(bridge, new Adb());
  const signal = new AbortController().signal;
  try {
    const observed = await client.execute("get_ui_tree", {}, signal);
    assert.ok((observed.meta as any).returnedBytes < (observed.meta as any).sourceBytes);
    const result = await client.execute("act_and_observe", { action: "click_element", arguments: target }, signal);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    assert.equal((result.result as any).observation.snapshotId, next.snapshotId);
    failedObservation = true;
    const after = await client.execute("act_and_observe", { action: "click_element", arguments: { ...target, snapshotId: next.snapshotId } }, signal);
    assert.equal(after.ok, true);
    assert.equal((after.result as any).action.accepted, true);
    assert.equal((after.result as any).observationError.code, "NO_ACTIVE_WINDOW");
    const replay = await client.execute("act_and_observe", { action: "click_element", arguments: { ...target, snapshotId: next.snapshotId } }, signal);
    assert.equal((replay.error as any).code, "NO_KNOWN_SNAPSHOT");
    assert.equal(calls.length, 3);
  } finally { await client.close(); }
});

test("task cancellation during transport preparation gates dispatch; emergency stop remains callable", async () => {
  let release!: () => void;
  let ready!: () => void;
  const prepared = new Promise<void>((resolve) => { ready = resolve; });
  const dispatched: string[] = [];
  const bridge: PhoneBridge = { close: async () => {}, call: async (method, _args, _timeout, gate) => {
    if (method === "act_and_observe") { ready(); await new Promise<void>((resolve) => { release = resolve; }); }
    gate?.(); dispatched.push(method);
    return response(snapshot);
  } };
  const client = createPhoneClient(bridge, new Adb());
  const abort = new AbortController();
  try {
    const pending = client.execute("act_and_observe", { action: "open_settings", arguments: {} }, abort.signal);
    await prepared;
    abort.abort(); release();
    assert.equal(((await pending).error as any).code, "CANCELLED");
    await client.execute("emergency_stop", {}, abort.signal);
    assert.deepEqual(dispatched, ["emergency_stop"]);
  } finally { await client.close(); }
});

test("compaction preserves identity, ordering, disabled and hidden states, labels and hierarchy", () => {
  const source = { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, enabled: false, visible: false, text: "", parentId: "root", resourceId: "" }] };
  const compact = compactUi(source) as typeof source;
  assert.equal(compact.nodes[0]!.enabled, false);
  assert.equal(compact.nodes[0]!.visible, false);
  assert.equal(compact.nodes[0]!.nodeId, "n0");
  assert.equal(compact.nodes[0]!.parentId, "root");
  assert.deepEqual(compact.nodes[0]!.bounds, source.nodes[0]!.bounds);
  assert.equal(source.nodes[0]!.text, "");
  assert.ok(!("text" in compact.nodes[0]!));
});
