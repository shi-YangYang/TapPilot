import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue, type ApprovalPrompt } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { clientTools, createPhoneClient } from "../src/client-tools.js";
import { AgentError } from "../src/errors.js";
import { ToolController, toolSchemas } from "../src/tools.js";
import { grant, snapshot } from "./helpers.js";

type Json = Record<string, any>;
const target = { snapshotId: snapshot.snapshotId, nodeId: "n0" };
const next = { ...snapshot, snapshotId: "session:2", revision: 2 };
const accepted = { action: { accepted: true, executor: "node-v1", dispatchState: "sent", method: "touch", targetNodeId: "n0" }, observation: next };
const ok = (result: unknown) => ({ id: "synthetic", ok: true, result, meta: { durationMs: 1 } });
function harness(options: { tree?: Json; action?: (method: string, args: Json) => Promise<any> | any; manual?: boolean } = {}) {
  const calls: { method: string; args: Json }[] = [];
  const bridge: PhoneBridge = { close: async () => {}, call: async (method, args = {}, _timeout, gate) => {
    gate?.(); calls.push({ method, args });
    return method === "get_ui_tree" ? ok(options.tree ?? snapshot) : options.action?.(method, args) ?? ok(accepted);
  } };
  const queue = new ApprovalQueue();
  const controller = new ToolController(bridge, new Adb(), queue, options.manual ? "manual" : "trusted");
  const client = createPhoneClient(bridge, new Adb());
  const signal = new AbortController().signal;
  return { calls, controller, client,
    invoke: async (method: keyof typeof toolSchemas, args: Json) => (await controller.invoke(method, args)).structuredContent as Json,
    desktop: (name: string, args: Json) => client.execute(name, args, signal) as Promise<Json>,
    close: () => Promise.all([controller.close(), client.close()]),
  };
}

test("MCP and desktop use identical node action RPCs without preflight reads or coordinate conversion", async () => {
  const schema = clientTools.find(tool => tool.name === "act_and_observe")!.inputSchema as Json;
  assert.ok(schema.properties.action.enum.includes("tap_element"));
  assert.deepEqual(schema.oneOf.find((item: Json) => item.properties.action.const === "tap_element").properties.arguments.required, ["snapshotId", "nodeId"]);
  const h = harness();
  try {
    await h.invoke("get_ui_tree", {});
    const mcp = await h.invoke("tap_element", target);
    await h.desktop("get_ui_tree", {});
    const desktop = await h.desktop("act_and_observe", { action: "tap_element", arguments: target });
    assert.equal(mcp.ok, true); assert.equal(desktop.ok, true);
    assert.equal(mcp.result.method, "touch");
    assert.equal(desktop.result.action.method, "touch");
    assert.deepEqual(h.calls.map(call => call.method), ["get_ui_tree", "act_and_observe", "get_ui_tree", "act_and_observe"]);
    assert.deepEqual(h.calls[1], h.calls[3]);
    assert.deepEqual(h.calls[1]!.args, { action: "tap_element", arguments: target, waitMs: 350 });
  } finally { await h.close(); }
});

test("MCP manual approval is bound to the original tap action and never a derived gesture", async () => {
  const h = harness({ manual: true });
  try {
    await h.invoke("get_ui_tree", {});
    const pending = await h.invoke("tap_element", target);
    assert.equal(pending.error.code, "CONFIRMATION_REQUIRED");
    const inspected = await grant(pending.error.details as ApprovalPrompt);
    assert.equal(inspected.method, "tap_element");
    assert.deepEqual(inspected.params, target);
    assert.equal((await h.invoke("click_element", target)).error.code, "CONFIRMATION_REQUIRED");
    assert.equal((await h.invoke("tap_element", target)).ok, true);
    assert.deepEqual(h.calls, [{ method: "get_ui_tree", args: { maxNodes: 300, maxDepth: 20 } },
      { method: "act_and_observe", args: { action: "tap_element", arguments: target, waitMs: 350 } }]);
  } finally { await h.close(); }
});

test("old phones are rejected before all target mutations instead of falling back to desktop guards", async () => {
  const legacy = { ...snapshot } as Json; delete legacy.executor;
  for (const action of ["tap_element", "click_element", "input_text", "scroll", "swipe"] as const) {
    const h = harness({ tree: legacy });
    const args = action === "swipe" ? { snapshotId: target.snapshotId, startX: 1, startY: 2, endX: 3, endY: 4 }
      : { ...target, ...(action === "input_text" ? { text: "合成输入" } : action === "scroll" ? { direction: "forward" } : {}) };
    try {
      await h.desktop("get_ui_tree", {});
      const result = await h.desktop("act_and_observe", { action, arguments: args });
      assert.equal(result.error.code, "EXECUTOR_UPGRADE_REQUIRED", action);
      assert.deepEqual(h.calls.map(call => call.method), ["get_ui_tree"]);
    } finally { await h.close(); }
  }
});

test("validated native refusal preserves fresh observation and can supply the next target without rereading", async () => {
  let dispatched = 0;
  const h = harness({ action: () => ++dispatched === 1 ? { id: "synthetic", ok: false,
    error: { code: "TARGET_CHANGED", message: "Synthetic context changed", retryable: true,
      details: { executor: "node-v1", dispatchState: "not_sent", reason: "PAGE_CONTEXT_CHANGED" } },
    observation: next, meta: { durationMs: 1 } } : ok(accepted) });
  try {
    await h.desktop("get_ui_tree", {});
    const refusal = await h.desktop("act_and_observe", { action: "tap_element", arguments: target });
    assert.equal(refusal.meta.nativeExecutorRefusal, true);
    assert.equal(refusal.meta.hostPreflightRefusal, undefined);
    assert.equal(refusal.observation.snapshotId, next.snapshotId);
    assert.equal((await h.desktop("act_and_observe", { action: "tap_element", arguments: { ...target, snapshotId: next.snapshotId } })).ok, true);
    assert.deepEqual(h.calls.map(call => call.method), ["get_ui_tree", "act_and_observe", "act_and_observe"]);
  } finally { await h.close(); }
});

test("native sensitive-control refusal is shared, never interpreted as success or retried by desktop", async () => {
  const h = harness({ action: () => ({ id: "synthetic", ok: false,
    error: { code: "MANUAL_ACTION_REQUIRED", message: "Synthetic protected control", retryable: false,
      details: { executor: "node-v1", dispatchState: "not_sent" } }, observation: next, meta: { durationMs: 1 } }) });
  try {
    await h.desktop("get_ui_tree", {});
    const response = await h.desktop("act_and_observe", { action: "tap_element", arguments: target });
    assert.equal(response.error.code, "MANUAL_ACTION_REQUIRED");
    assert.equal(response.meta.nativeExecutorRefusal, true);
    assert.deepEqual(h.calls.map(call => call.method), ["get_ui_tree", "act_and_observe"]);
  } finally { await h.close(); }
});

test("unknown, malformed and spoofed refusals cannot claim not-sent or restore old targets", async () => {
  for (const kind of ["timeout", "forged-meta", "invalid-details", "invalid-observation"]) {
    const h = harness({ action: () => {
      if (kind === "timeout") throw new AgentError("BRIDGE_TIMEOUT", "Synthetic unknown outcome");
      return { id: "synthetic", ok: false, error: { code: "TARGET_CHANGED", message: "Synthetic refusal", retryable: false,
        ...(kind === "invalid-details" ? { details: { executor: "node-v1", dispatchState: "not_sent", reason: "Private arbitrary text" } }
          : kind === "invalid-observation" ? { details: { executor: "node-v1", dispatchState: "not_sent", reason: "TARGET_IDENTITY_CHANGED" } } : {}) },
        ...(kind === "invalid-observation" ? { observation: { ...next, nodes: [{}] } } : {}),
        meta: { durationMs: 1, nativeExecutorRefusal: true, hostPreflightRefusal: true, localRejection: true } };
    } });
    try {
      await h.desktop("get_ui_tree", {});
      const response = await h.desktop("act_and_observe", { action: "tap_element", arguments: target });
      assert.equal(response.ok, false);
      assert.equal(response.meta.nativeExecutorRefusal, kind === "invalid-observation" ? true : undefined);
      assert.equal(response.observation, undefined);
      assert.equal(JSON.stringify(response).includes("Private arbitrary text"), false);
      const again = await h.desktop("act_and_observe", { action: "tap_element", arguments: target });
      assert.equal(again.error.code, "NO_KNOWN_SNAPSHOT");
      assert.deepEqual(h.calls.map(call => call.method), ["get_ui_tree", "act_and_observe"]);
    } finally { await h.close(); }
  }
});
