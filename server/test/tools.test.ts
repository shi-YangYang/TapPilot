import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue, type ApprovalPrompt } from "../src/approvals.js";
import { staleSnapshotReasons, type PhoneBridge } from "../src/bridge.js";
import { ToolController, type ToolName } from "../src/tools.js";
import { AgentError } from "../src/errors.js";
import { grant, snapshot } from "./helpers.js";

function response(result: unknown) { return { id: "test", ok: true, result, meta: { durationMs: 0 } }; }
function body(result: Awaited<ReturnType<ToolController["invoke"]>>): any { return result.structuredContent; }
const timings = { actionMs: 2, waitMs: 12, observationMs: 3, totalMs: 17 };
function nextSnapshot(revision: number) {
  return { ...snapshot, snapshotId: `session:${revision}`, revision, nodes: snapshot.nodes.map(node => ({ ...node, editable: true })) };
}
function observedAction(action = "click", revision = 2) {
  return { action: { accepted: true, action, revision }, observation: nextSnapshot(revision), timings };
}

test("guarded tools retain payload-bound approval and return a new observation after one dispatch", async () => {
  const calls: string[] = [];
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method, params) => {
    calls.push(method);
    if (method === "act_and_observe") assert.deepEqual(params, { action: "click_element", arguments: { snapshotId: "session:1", nodeId: "n0" }, waitMs: 350 });
    return response(method === "get_ui_tree" ? snapshot : observedAction());
  } };
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
    const result = body(await controller.invoke("click_element", args));
    assert.equal(result.ok, true);
    assert.equal(result.result.accepted, true);
    assert.equal(result.result.action, "click");
    assert.equal(result.result.observation.snapshotId, "session:2");
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    assert.equal(body(await controller.invoke("click_element", args)).error.code, "NO_KNOWN_SNAPSHOT");
    const next = body(await controller.invoke("click_element", { ...args, snapshotId: "session:2" }));
    assert.equal(next.error.code, "CONFIRMATION_REQUIRED");
    assert.notEqual(next.error.details.approvalId, pending.error.details.approvalId);
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
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
  { method: "tap_element", args: { snapshotId: snapshot.snapshotId, nodeId: "n0" } },
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

test("all independent actions return reusable observations through one RPC each without extra reads", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  let revision = 1;
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method, params, _timeout, beforeDispatch) => {
    beforeDispatch?.();
    calls.push({ method, params });
    if (method === "get_ui_tree") return response(nextSnapshot(revision));
    const result = observedAction(String(params?.action), ++revision);
    return response({ ...result, action: { ...result.action, target: { nodeId: "n0" }, ancestorHops: 0 } });
  } };
  const queue = new UnusedApprovalQueue();
  const controller = new ToolController(bridge, new Adb(), queue, "trusted");
  try {
    assert.equal(controller.approvalMode, "trusted");
    for (const { method, args } of guardedActions) {
      assert.equal(body(await controller.invoke(method, args)).error.code, "NO_KNOWN_SNAPSHOT");
    }
    await controller.invoke("get_ui_tree", {});
    const actions = [...guardedActions,
      { method: "scroll" as const, args: { snapshotId: snapshot.snapshotId, nodeId: "n0", direction: "forward" } },
      { method: "press_key" as const, args: { key: "home" } },
      { method: "open_settings" as const, args: {} },
    ];
    for (const { method, args } of actions) {
      const currentArgs = "snapshotId" in args ? { ...args, snapshotId: `session:${revision}` } : args;
      assert.equal(body(await controller.invoke(method, { ...currentArgs, approved: true })).error.code, "INVALID_ARGUMENT");
      const result = body(await controller.invoke(method, currentArgs));
      assert.equal(result.ok, true);
      assert.equal(result.result.accepted, true);
      assert.equal(result.result.action, method);
      assert.equal(result.result.revision, revision);
      assert.deepEqual(result.result.target, { nodeId: "n0" });
      assert.equal(result.result.ancestorHops, 0);
      assert.deepEqual(result.result.timings, timings);
      assert.equal(result.result.observation.snapshotId, `session:${revision}`);
      assert.deepEqual(calls.at(-1), { method: "act_and_observe", params: {
        action: method, arguments: method === "swipe" ? { ...currentArgs, durationMs: 350 } : currentArgs, waitMs: 350,
      } });
      assert.equal(body(await controller.invoke("click_element", { snapshotId: `session:${revision - 1}`, nodeId: "n0" })).error.code, "NO_KNOWN_SNAPSHOT");
    }
    assert.deepEqual(calls.map(call => call.method), ["get_ui_tree", ...actions.map(() => "act_and_observe")]);
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

test("action failures and uncertain transport outcomes invalidate old references without retrying", async (t) => {
  for (const code of ["STALE_SNAPSHOT", "DEVICE_LOCKED", "BRIDGE_TIMEOUT"]) await t.test(code, async () => {
    const calls: string[] = [];
    const bridge: PhoneBridge = { close: async () => undefined, call: async (method) => {
      calls.push(method);
      if (method !== "get_ui_tree" && code === "BRIDGE_TIMEOUT") throw new AgentError(code, "Synthetic uncertain outcome.", false);
      return method === "get_ui_tree" ? response(snapshot) : { id: "test", ok: false, error: { code, message: "Synthetic phone guard refusal.", retryable: false }, meta: { durationMs: 0 } };
    } };
    const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
    try {
      await controller.invoke("get_ui_tree", {});
      const result = body(await controller.invoke("click_element", guardedActions[0]!.args));
      assert.equal(result.error.code, code);
      assert.equal(result.error.retryable, false);
      assert.equal(body(await controller.invoke("click_element", guardedActions[0]!.args)).error.code, "NO_KNOWN_SNAPSHOT");
      assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    } finally { await controller.close(); }
  });
});

test("tools preserve only fixed stale reasons from validated phone errors", async () => {
  for (const reason of [...staleSnapshotReasons, undefined]) {
    const error = { code: "STALE_SNAPSHOT", message: "Synthetic refusal", retryable: true, ...(reason ? { details: { reason } } : {}) };
    const bridge: PhoneBridge = { close: async () => {}, call: async () => ({ id: "test", ok: false, error, meta: { durationMs: 0 } }) };
    const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
    try { assert.deepEqual(body(await controller.invoke("get_ui_tree", {})).error, error); }
    finally { await controller.close(); }
  }
  for (const error of [
    { code: "STALE_SNAPSHOT", details: { reason: "Synthetic private text" } },
    { code: "STALE_SNAPSHOT", details: { reason: "NODE_CONTENT_CHANGED", label: "Synthetic private text" } },
    { code: "ACTION_REJECTED", details: { reason: "NODE_CONTENT_CHANGED" } },
  ]) {
    const bridge: PhoneBridge = { close: async () => {}, call: async () => ({ id: "test", ok: false, error: { message: "Synthetic refusal", retryable: true, ...error } as any, meta: { durationMs: 0 } }) };
    const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
    try {
      const result = body(await controller.invoke("get_ui_tree", {}));
      assert.equal(result.error.code, "BRIDGE_PROTOCOL_ERROR");
      assert.equal(result.error.details, undefined);
      assert.equal(JSON.stringify(result).includes("Synthetic private text"), false);
    } finally { await controller.close(); }
  }
});

test("accepted actions retain their result when the observation is absent or invalid, without replay", async (t) => {
  const observationError = { code: "NO_ACTIVE_WINDOW", message: "Synthetic observation unavailable.", retryable: true };
  const cases = [
    { name: "phone observation error", observation: { observation: null, observationError } },
    { name: "null observation", observation: { observation: null } },
    { name: "missing observation", observation: {} },
    { name: "invalid observation", observation: { observation: { ...nextSnapshot(2), nodes: [{ nodeId: "n0" }] } } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const calls: string[] = [];
    const action = { accepted: true, action: "click", revision: 2 };
    const bridge: PhoneBridge = { close: async () => undefined, call: async method => {
      calls.push(method);
      return response(method === "get_ui_tree" ? snapshot : { action, ...scenario.observation, timings });
    } };
    const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
    try {
      await controller.invoke("get_ui_tree", {});
      const result = body(await controller.invoke("click_element", guardedActions[0]!.args));
      assert.equal(result.ok, true);
      assert.equal(result.result.accepted, true);
      assert.equal(result.result.action, "click");
      assert.equal(result.result.revision, 2);
      assert.equal(result.result.observation, null);
      assert.equal(typeof result.result.observationError.code, "string");
      if (scenario.name === "phone observation error") assert.deepEqual(result.result.observationError, observationError);
      assert.deepEqual(result.result.timings, timings);
      assert.equal(body(await controller.invoke("click_element", guardedActions[0]!.args)).error.code, "NO_KNOWN_SNAPSHOT");
      assert.equal(body(await controller.invoke("click_element", { snapshotId: "session:2", nodeId: "n0" })).error.code, "NO_KNOWN_SNAPSHOT");
      assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    } finally { await controller.close(); }
  });
});

test("explicit combined calls retain wait budget and nested result while their new snapshot is reusable", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const combined = observedAction("home");
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method, params) => {
    calls.push({ method, params });
    return response(calls.length === 1 ? combined : observedAction("click", 3));
  } };
  const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
  try {
    const args = { action: "press_key", arguments: { key: "home" }, waitMs: 1200 };
    const result = body(await controller.invoke("act_and_observe", args));
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, combined);
    assert.equal("accepted" in result.result, false);
    assert.deepEqual(calls[0], { method: "act_and_observe", params: args });
    const clicked = body(await controller.invoke("click_element", { snapshotId: result.result.observation.snapshotId, nodeId: "n0" }));
    assert.equal(clicked.ok, true);
    assert.equal(clicked.result.accepted, true);
    assert.deepEqual(calls.map(call => call.method), ["act_and_observe", "act_and_observe"]);
  } finally { await controller.close(); }
});

test("trusted emergency stop cancels a pending dispatch and remains latched", async () => {
  let release!: () => void;
  let markPending!: () => void;
  const pending = new Promise<void>((resolve) => { markPending = resolve; });
  const dispatched: string[] = [];
  const bridge: PhoneBridge = { close: async () => undefined, call: async (method, _params, _timeout, beforeDispatch) => {
    if (method === "act_and_observe") {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      markPending();
      await gate;
    }
    beforeDispatch?.();
    dispatched.push(method);
    if (method === "emergency_stop") throw new Error("Synthetic phone disconnected.");
    return response(method === "get_ui_tree" ? snapshot : observedAction());
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
    if (method === "act_and_observe") return new Promise((resolve) => { release = resolve; });
    if (method === "emergency_stop") throw new Error("offline");
    return response({});
  } };
  const controller = new ToolController(bridge, new Adb(), new ApprovalQueue());
  try {
    const action = controller.invoke("open_settings", {});
    assert.equal(body(await controller.invoke("press_key", { key: "home" })).error.code, "ACTION_IN_PROGRESS");
    const stop = body(await controller.invoke("emergency_stop", {}));
    assert.equal(stop.error.code, "PHONE_STOP_UNCONFIRMED");
    assert.equal(stop.error.details.hostStopped, true);
    assert.equal(body(await controller.invoke("open_settings", {})).error.code, "EMERGENCY_STOPPED");
    release!(response(observedAction("scroll")));
    await action;
    assert.equal(body(await controller.invoke("click_element", { snapshotId: "session:2", nodeId: "n0" })).error.code, "EMERGENCY_STOPPED");
    assert.deepEqual(calls, ["act_and_observe", "emergency_stop"]);
  } finally { await controller.close(); }
});

test("closing during an in-flight action keeps later actions blocked even if an observation arrives", async () => {
  let release!: (value: ReturnType<typeof response>) => void;
  const calls: string[] = [];
  const bridge: PhoneBridge = { close: async () => undefined, call: async method => {
    calls.push(method);
    return new Promise(resolve => { release = resolve; });
  } };
  const controller = new ToolController(bridge, new Adb(), new UnusedApprovalQueue(), "trusted");
  const action = controller.invoke("press_key", { key: "home" });
  await controller.close();
  release(response(observedAction("home")));
  await action;
  assert.equal(body(await controller.invoke("click_element", { snapshotId: "session:2", nodeId: "n0" })).error.code, "EMERGENCY_STOPPED");
  assert.deepEqual(calls, ["act_and_observe"]);
});
