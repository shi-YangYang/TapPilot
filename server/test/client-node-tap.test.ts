import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import type { PhoneBridge } from "../src/bridge.js";
import { clientTools, createPhoneClient } from "../src/client-tools.js";
import { snapshot } from "./helpers.js";

type Json = Record<string, any>;
function node(nodeId: string, bounds: number[], overrides: Json = {}): Json {
  return { ...snapshot.nodes[0]!, nodeId, parentId: "root", text: "", contentDescription: "", resourceId: "", clickable: false, visible: true, bounds, ...overrides };
}
const root = node("root", [0, 0, 400, 600], { parentId: null });
const button = node("button", [20, 20, 120, 120], { clickable: true, text: "工具" });
const target = { snapshotId: snapshot.snapshotId, nodeId: button.nodeId };
function success(result: unknown) { return { id: "synthetic", ok: true, result, meta: { durationMs: 1 } }; }
function harness(options: { nodes?: Json[]; truncated?: boolean; partial?: boolean; actionResult?: Json; phoneError?: string; prepare?: () => Promise<void> } = {}) {
  const full = { ...snapshot, nodes: options.nodes ?? [root, button], truncated: options.truncated ?? false };
  const observed = options.partial ? { ...full, nodes: undefined, elements: full.nodes } : full;
  const calls: { method: string; args: Json }[] = [];
  const bridge: PhoneBridge = { close: async () => {}, call: async (method, args, _timeout, gate) => {
    if (method === "act_and_observe") await options.prepare?.();
    gate?.(); calls.push({ method, args });
    if (method === "get_ui_tree") return success(observed);
    if (options.phoneError && method === "act_and_observe") return { id: "synthetic", ok: false, error: { code: options.phoneError, message: "Synthetic phone rejection", retryable: false }, meta: { durationMs: 1 } };
    return success(options.actionResult ?? { action: { accepted: true, action: "swipe", completion: "pending" }, observation: { ...full, snapshotId: "session:2", revision: 2 } });
  } };
  const client = createPhoneClient(bridge, new Adb());
  const signal = new AbortController().signal;
  return {
    client, calls,
    read: () => client.execute("get_ui_tree", {}, signal),
    tap: (args: Json = target, customSignal = signal) => client.execute("act_and_observe", { action: "tap_element", arguments: args }, customSignal),
  };
}
async function attempt(options: Parameters<typeof harness>[0] = {}, args: Json = target) {
  const h = harness(options);
  try { assert.equal((await h.read()).ok, true); return { result: await h.tap(args), calls: h.calls }; }
  finally { await h.client.close(); }
}
function blocked(actual: Awaited<ReturnType<typeof attempt>>, code: string) {
  assert.equal(actual.result.ok, false);
  assert.equal((actual.result.error as Json).code, code);
  assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree"], "rejected node taps must not dispatch a phone action");
}

test("tap schema accepts node identity; one RPC performs one touch and reports host identity", async () => {
  const schema = clientTools.find((tool) => tool.name === "act_and_observe")!.inputSchema as Json;
  assert.ok(schema.properties.action.enum.includes("tap_element"));
  const branch = schema.oneOf.find((entry: Json) => entry.properties.action.const === "tap_element");
  assert.deepEqual(branch.properties.arguments.required, ["snapshotId", "nodeId"]);
  const actual = await attempt();
  assert.equal(actual.result.ok, true);
  assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "act_and_observe"]);
  assert.deepEqual(actual.calls[1]!.args, { action: "swipe", arguments: { snapshotId: target.snapshotId, startX: 70, startY: 70, endX: 70, endY: 70, durationMs: 80 }, waitMs: 350 });
  const action = (actual.result.result as Json).action;
  assert.equal(action.action, "tap");
  assert.equal(action.method, "touch");
  assert.equal(action.targetNodeId, "button");
  assert.equal(action.actedNodeId, "button");
  assert.equal(action.accepted, true);
  assert.equal(action.completion, "pending");
  assert.equal(action.target, undefined, "do not copy UI subtrees into action history");
});

test("non-clickable child maps to its clickable parent and touches only the observed intersection", async () => {
  const label = node("label", [10, 30, 40, 80], { parentId: button.nodeId, text: "工具说明" });
  const actual = await attempt({ nodes: [root, button, label] }, { ...target, nodeId: label.nodeId });
  assert.equal(actual.result.ok, true);
  assert.deepEqual(actual.calls[1]!.args.arguments, { snapshotId: target.snapshotId, startX: 30, startY: 55, endX: 30, endY: 55, durationMs: 80 });
  assert.equal((actual.result.result as Json).action.targetNodeId, "label");
  assert.equal((actual.result.result as Json).action.actedNodeId, "button");
});

test("tap center must hit the expected target uniquely, including deeper clickable children", async () => {
  const overlap = node("overlap", [30, 30, 130, 130], { clickable: true });
  blocked(await attempt({ nodes: [root, button, overlap] }), "NODE_NOT_ACTIONABLE");
  const deeper = { ...overlap, parentId: button.nodeId };
  blocked(await attempt({ nodes: [root, button, deeper] }), "NODE_NOT_ACTIONABLE");
});

test("tap is clipped by every observed ancestor and rejects hidden or fully clipped targets", async () => {
  const container = node("container", [40, 40, 80, 80]);
  const clipped = { ...button, parentId: "container" };
  const actual = await attempt({ nodes: [root, container, clipped] });
  assert.equal(actual.result.ok, true);
  assert.deepEqual(actual.calls[1]!.args.arguments, { snapshotId: target.snapshotId, startX: 60, startY: 60, endX: 60, endY: 60, durationMs: 80 });
  blocked(await attempt({ nodes: [root, { ...container, visible: false }, clipped] }), "NODE_NOT_ACTIONABLE");
  blocked(await attempt({ nodes: [root, { ...container, bounds: [150, 150, 200, 200] }, clipped] }), "NODE_NOT_ACTIONABLE");
  const intermediate = node("intermediate", [50, 50, 80, 80], { parentId: "button" });
  const label = node("label", [30, 30, 100, 100], { parentId: "intermediate" });
  const childTap = await attempt({ nodes: [root, button, intermediate, label] }, { ...target, nodeId: "label" });
  assert.equal(childTap.result.ok, true);
  assert.equal(childTap.calls[1]!.args.arguments.startX, 65);
});

test("touch cannot land on a non-clickable password descendant inside a clickable container", async () => {
  const password = node("password", [50, 50, 100, 100], { parentId: "button", password: true, text: "[REDACTED]" });
  blocked(await attempt({ nodes: [root, button, password] }), "NODE_NOT_ACTIONABLE");
});

test("ordinary tap excludes unrelated sensitive siblings but checks intended descendants and containing labels", async () => {
  const sensitive = node("sensitive", [150, 20, 250, 120], { text: "支付入口", clickable: true });
  assert.equal((await attempt({ nodes: [root, button, sensitive] })).result.ok, true);
  const label = node("label", [90, 90, 110, 110], { parentId: button.nodeId, text: "立即支付" });
  blocked(await attempt({ nodes: [root, button, label] }), "MANUAL_ACTION_REQUIRED");
  blocked(await attempt({ nodes: [{ ...root, text: "提交订单" }, button] }), "MANUAL_ACTION_REQUIRED");
  const child = node("child", [30, 30, 60, 60], { parentId: button.nodeId, text: "确认" });
  blocked(await attempt({ nodes: [root, button, child, label] }, { ...target, nodeId: "child" }), "MANUAL_ACTION_REQUIRED");
});

test("partial, truncated and stale snapshots cannot authorize a node touch", async () => {
  blocked(await attempt({ partial: true }), "NODE_NOT_ACTIONABLE");
  blocked(await attempt({ truncated: true }), "NODE_NOT_ACTIONABLE");
  blocked(await attempt({}, { ...target, snapshotId: "session:old" }), "STALE_SNAPSHOT");
  blocked(await attempt({}, { ...target, nodeId: "missing" }), "NODE_NOT_FOUND");
});

test("disabled, hidden, password and malformed geometry targets are rejected", async () => {
  for (const override of [{ enabled: false }, { visible: false }, { password: true }, { bounds: [20, 20, 20, 120] }, { bounds: [410, 20, 510, 120] }]) {
    blocked(await attempt({ nodes: [root, { ...button, ...override }] }), "NODE_NOT_ACTIONABLE");
  }
  const child = node("child", [30, 30, 60, 60], { parentId: button.nodeId });
  for (const override of [{ enabled: false }, { visible: false }, { password: true }]) {
    blocked(await attempt({ nodes: [root, { ...button, ...override }, child] }, { ...target, nodeId: "child" }), "NODE_NOT_ACTIONABLE");
  }
  blocked(await attempt({ nodes: [{ ...root, bounds: [0, 0, 0, 600] }, button] }), "NODE_NOT_ACTIONABLE");
});

test("missing, cyclic and overly deep ancestry never guesses another touch point", async () => {
  blocked(await attempt({ nodes: [root, { ...button, clickable: false, parentId: "missing" }] }), "NODE_NOT_ACTIONABLE");
  blocked(await attempt({ nodes: [root, { ...button, parentId: "button" }] }), "NODE_NOT_ACTIONABLE");
  const chain = Array.from({ length: 9 }, (_, index) => node(`child${index}`, [20, 20, 120, 120], { parentId: index === 8 ? "button" : `child${index + 1}` }));
  blocked(await attempt({ nodes: [root, button, ...chain] }, { ...target, nodeId: "child0" }), "NODE_NOT_ACTIONABLE");
});

test("nested node arguments reject coordinates, unknown fields and invalid identity before dispatch", async () => {
  for (const args of [{ ...target, startX: 70 }, { ...target, nodeId: "" }, { ...target, approved: true }, { snapshotId: target.snapshotId }]) {
    blocked(await attempt({}, args), "INVALID_ARGUMENT");
  }
});

test("Android stale and action rejection errors propagate unchanged with no automatic retry", async () => {
  for (const code of ["STALE_SNAPSHOT", "ACTION_REJECTED", "PROTECTED_APP"]) {
    const actual = await attempt({ phoneError: code });
    assert.equal(actual.result.ok, false);
    assert.equal((actual.result.error as Json).code, code);
    assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "act_and_observe"]);
  }
});

test("observation failure keeps accepted touch facts and invalidates targets without replay", async () => {
  const h = harness({ actionResult: { action: { accepted: true, action: "swipe", method: "spoof", targetNodeId: "spoof", actedNodeId: "spoof" }, observationError: { code: "NO_ACTIVE_WINDOW", message: "Synthetic transition" } } });
  try {
    await h.read();
    const result = await h.tap();
    assert.equal(result.ok, true);
    assert.equal((result.result as Json).action.targetNodeId, "button");
    assert.equal((result.result as Json).action.method, "touch");
    assert.equal((result.result as Json).observationError.code, "NO_ACTIVE_WINDOW");
    assert.equal(((await h.tap()).error as Json).code, "NO_KNOWN_SNAPSHOT");
    assert.equal(h.calls.length, 2);
  } finally { await h.client.close(); }
});

test("cancellation and emergency stop during preparation gate the translated touch dispatch", async () => {
  for (const stop of [false, true]) {
    let release!: () => void, ready!: () => void;
    const prepared = new Promise<void>((resolve) => { ready = resolve; });
    const h = harness({ prepare: async () => { ready(); await new Promise<void>((resolve) => { release = resolve; }); } });
    const abort = new AbortController();
    try {
      await h.read();
      const pending = h.tap(target, abort.signal);
      await prepared;
      if (stop) await h.client.execute("emergency_stop", {}, abort.signal);
      else abort.abort();
      release();
      assert.equal(((await pending).error as Json).code, stop ? "EMERGENCY_STOPPED" : "CANCELLED");
      assert.deepEqual(h.calls.map((call) => call.method), stop ? ["get_ui_tree", "emergency_stop"] : ["get_ui_tree"]);
    } finally { await h.client.close(); }
  }
});
