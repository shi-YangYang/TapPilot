import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue, type ApprovalPrompt } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { ToolController, type ToolName } from "../src/tools.js";
import { grant, snapshot } from "./helpers.js";

function response(result: unknown) { return { id: "test", ok: true, result, meta: { durationMs: 0 } }; }
function body(result: Awaited<ReturnType<ToolController["invoke"]>>): any { return result.structuredContent; }

test("guarded tools need observed targets, no approved:true bypass, payload-bound approval and refresh after action", async () => {
  const calls: string[] = [];
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method) => { calls.push(method); return response(method === "get_ui_tree" ? snapshot : { accepted: true, revision: 2 }); } };
  const queue = new ApprovalQueue();
  const controller = new ToolController(bridge, new Adb(), queue);
  try {
    assert.equal(controller.approvalMode, "manual");
    const args = { snapshotId: "session:1", nodeId: "n0" };
    assert.equal(body(await controller.invoke("click_element", args)).error.code, "NO_KNOWN_SNAPSHOT");
    await controller.invoke("get_ui_tree", {});
    assert.equal(body(await controller.invoke("click_element", { ...args, approved: true })).error.code, "INVALID_ARGUMENT");
    const pending = body(await controller.invoke("click_element", args));
    assert.equal(pending.error.code, "CONFIRMATION_REQUIRED");
    assert.deepEqual(calls, ["get_ui_tree"]);
    const inspected = await grant(pending.error.details as ApprovalPrompt);
    assert.equal(inspected.preview.target.text, "电池");
    assert.equal(inspected.preview.packageName, "com.android.settings");
    assert.equal(body(await controller.invoke("click_element", args)).ok, true);
    assert.deepEqual(calls, ["get_ui_tree", "click_element"]);
    assert.equal(body(await controller.invoke("click_element", args)).error.code, "NO_KNOWN_SNAPSHOT");
  } finally { await controller.close(); }
});

class UnusedApprovalQueue extends ApprovalQueue {
  requireCalls = 0;
  startCalls = 0;
  override async require(): Promise<ApprovalPrompt | undefined> {
    this.requireCalls++;
    throw new Error("Trusted mode must not request or fabricate an approval.");
  }
  override async start(): Promise<void> {
    this.startCalls++;
    throw new Error("Trusted mode must not create an approval socket.");
  }
}

const guardedActions: Array<{ method: ToolName; args: Record<string, unknown> }> = [
  { method: "click_element", args: { snapshotId: snapshot.snapshotId, nodeId: "n0" } },
  { method: "input_text", args: { snapshotId: snapshot.snapshotId, nodeId: "n0", text: "测试输入" } },
  { method: "swipe", args: { snapshotId: snapshot.snapshotId, startX: 100, startY: 300, endX: 100, endY: 100 } },
];

test("explicit manual mode keeps all guarded actions behind human approval", async () => {
  const calls: string[] = [];
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method) => {
    calls.push(method);
    return response(snapshot);
  } };
  const controller = new ToolController(bridge, new Adb(), new ApprovalQueue(), "manual");
  try {
    await controller.invoke("get_ui_tree", {});
    for (const { method, args } of guardedActions) {
      assert.equal(body(await controller.invoke(method, args)).error.code, "CONFIRMATION_REQUIRED");
    }
    assert.deepEqual(calls, ["get_ui_tree"]);
  } finally { await controller.close(); }
});

test("trusted actions dispatch once from observed snapshots without approval calls or sockets", async () => {
  const calls: string[] = [];
  const editable = { ...snapshot, nodes: snapshot.nodes.map((node) => ({ ...node, editable: true })) };
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method, _params, _timeout, beforeDispatch) => {
    beforeDispatch?.();
    calls.push(method);
    return response(method === "get_ui_tree" ? editable : { accepted: true, revision: 2 });
  } };
  const queue = new UnusedApprovalQueue();
  const controller = new ToolController(bridge, new Adb(), queue, "trusted");
  try {
    assert.equal(controller.approvalMode, "trusted");
    for (const { method, args } of guardedActions) {
      assert.equal(body(await controller.invoke(method, args)).error.code, "NO_KNOWN_SNAPSHOT");
      await controller.invoke("get_ui_tree", {});
      assert.equal(body(await controller.invoke(method, { ...args, approved: true })).error.code, "INVALID_ARGUMENT");
      assert.equal(body(await controller.invoke(method, args)).ok, true);
      assert.equal(body(await controller.invoke(method, args)).error.code, "NO_KNOWN_SNAPSHOT");
    }
    assert.deepEqual(calls, ["get_ui_tree", "click_element", "get_ui_tree", "input_text", "get_ui_tree", "swipe"]);
    assert.equal(queue.requireCalls, 0);
    assert.equal(queue.startCalls, 0);
  } finally { await controller.close(); }
});

test("trusted mode rejects unknown nodes, password fields, and expired observed snapshots", async (t) => {
  const calls: string[] = [];
  const password = { ...snapshot, nodes: snapshot.nodes.map((node) => ({ ...node, editable: true, password: true, text: "" })) };
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method) => {
    calls.push(method);
    return response(password);
  } };
  const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
  try {
    await controller.invoke("get_ui_tree", {});
    assert.equal(body(await controller.invoke("click_element", { snapshotId: snapshot.snapshotId, nodeId: "missing" })).error.code, "NODE_NOT_FOUND");
    assert.equal(body(await controller.invoke("input_text", { snapshotId: snapshot.snapshotId, nodeId: "n0", text: "synthetic" })).error.code, "PASSWORD_FIELD_BLOCKED");
    const afterExpiry = Date.now() + 120_001;
    t.mock.method(Date, "now", () => afterExpiry);
    assert.equal(body(await controller.invoke("click_element", guardedActions[0]!.args)).error.code, "NO_KNOWN_SNAPSHOT");
    assert.deepEqual(calls, ["get_ui_tree"]);
  } finally { t.mock.restoreAll(); await controller.close(); }
});

test("trusted mode preserves Android stale and locked errors without retrying", async (t) => {
  for (const code of ["STALE_SNAPSHOT", "DEVICE_LOCKED"]) await t.test(code, async () => {
    const calls: string[] = [];
    const bridge: PhoneBridge = { close: async () => undefined, call: async (method) => {
      calls.push(method);
      return method === "get_ui_tree" ? response(snapshot) : { id: "test", ok: false, error: { code, message: "Synthetic phone guard refusal.", retryable: false }, meta: { durationMs: 0 } };
    } };
    const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
    try {
      await controller.invoke("get_ui_tree", {});
      const result = body(await controller.invoke("click_element", guardedActions[0]!.args));
      assert.equal(result.error.code, code);
      assert.equal(result.error.retryable, false);
      assert.deepEqual(calls, ["get_ui_tree", "click_element"]);
    } finally { await controller.close(); }
  });
});

test("trusted emergency stop cancels a pending dispatch and remains latched", async () => {
  let release!: () => void;
  let markPending!: () => void;
  const pending = new Promise<void>((resolve) => { markPending = resolve; });
  const dispatched: string[] = [];
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method, _params, _timeout, beforeDispatch) => {
    if (method === "click_element") {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      markPending();
      await gate;
    }
    beforeDispatch?.();
    dispatched.push(method);
    if (method === "emergency_stop") throw new Error("Synthetic phone disconnected.");
    return response(method === "get_ui_tree" ? snapshot : { accepted: true });
  } };
  const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
  try {
    await controller.invoke("get_ui_tree", {});
    const action = controller.invoke("click_element", guardedActions[0]!.args);
    await pending;
    assert.equal(body(await controller.invoke("press_key", { key: "home" })).error.code, "ACTION_IN_PROGRESS");
    assert.equal(body(await controller.invoke("emergency_stop", {})).error.code, "PHONE_STOP_UNCONFIRMED");
    release();
    assert.equal(body(await action).error.code, "EMERGENCY_STOPPED");
    assert.equal(body(await controller.invoke("open_settings", {})).error.code, "EMERGENCY_STOPPED");
    assert.deepEqual(dispatched, ["get_ui_tree", "emergency_stop"]);
  } finally { release?.(); await controller.close(); }
});

test("device info reports approval mode with both available and unavailable phone bridges", async () => {
  class NoDeviceAdb extends Adb { override async devices() { return []; } }
  for (const mode of ["manual", "trusted"] as const) {
    for (const connected of [true, false]) {
      const bridge: PhoneBridge = { close: async () => undefined, call: async () => {
        if (!connected) throw new Error("Synthetic unavailable bridge.");
        return response({ serviceConnected: true });
      } };
      const controller = new ToolController(bridge, new NoDeviceAdb(), new UnusedApprovalQueue(), mode);
      try {
        const info = body(await controller.invoke("get_device_info", {}));
        assert.equal(info.ok, true);
        assert.equal(info.result.approvalMode, mode);
        assert.equal(info.result.bridge.ok, connected);
      } finally { await controller.close(); }
    }
  }
});

test("emergency stop bypasses a pending mutation and remains latched when phone stop fails", async () => {
  let release: ((value: ReturnType<typeof response>) => void) | undefined;
  const calls: string[] = [];
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method) => {
    calls.push(method);
    if (method === "scroll") return new Promise((resolve) => { release = resolve; });
    if (method === "emergency_stop") throw new Error("offline");
    return response({});
  } };
  const controller = new ToolController(bridge, new Adb(), new ApprovalQueue());
  try {
    const action = controller.invoke("scroll", { snapshotId: "s", nodeId: "n", direction: "forward" });
    assert.equal(body(await controller.invoke("press_key", { key: "home" })).error.code, "ACTION_IN_PROGRESS");
    const stop = body(await controller.invoke("emergency_stop", {}));
    assert.equal(stop.error.code, "PHONE_STOP_UNCONFIRMED");
    assert.equal(stop.error.details.hostStopped, true);
    assert.equal(body(await controller.invoke("open_settings", {})).error.code, "EMERGENCY_STOPPED");
    release!(response({ accepted: true }));
    await action;
    assert.deepEqual(calls, ["scroll", "emergency_stop"]);
  } finally { await controller.close(); }
});
