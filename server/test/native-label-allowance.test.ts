import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Adb } from "../src/adb.js";
import { ApprovalQueue } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { clientTools, createPhoneClient } from "../src/client-tools.js";
import { projectToolResult } from "../src/runtime/ui-projection.js";
import { createMcpServer, ToolController, toolSchemas } from "../src/tools.js";
import { snapshot } from "./helpers.js";

type Json = Record<string, any>;
const target = { snapshotId: snapshot.snapshotId, nodeId: "n0" };
const allowance = ["status-clock", "loading-counter"];
const next = { ...snapshot, snapshotId: "session:2", revision: 2 };
const ok = (result: unknown) => ({ id: "synthetic", ok: true, result, meta: { durationMs: 1 } });

async function harness(legacy = false) {
  const calls: { method: string; args: Json }[] = [];
  const bridge: PhoneBridge = { close: async () => {}, call: async (method, args = {}, _timeout, gate) => {
    gate?.(); calls.push({ method, args });
    if (method === "get_ui_tree") return ok(snapshot);
    const actionArgs = args.arguments as Json;
    if (legacy && Object.hasOwn(actionArgs, "allowedLabelChanges")) return {
      id: "synthetic", ok: false, error: { code: "INVALID_ARGUMENT", message: "Unknown action argument", retryable: false }, meta: { durationMs: 1 },
    };
    return ok({ action: { accepted: true, executor: "node-v1", dispatchState: "sent",
      contextVerification: actionArgs.allowedLabelChanges ? "explicit_label_changes" : "default_context",
      allowedLabelChangesCount: actionArgs.allowedLabelChanges?.length ?? 0 }, observation: next });
  } };
  const controller = new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted");
  const server = createMcpServer(controller);
  const mcp = new Client({ name: "synthetic-label-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const desktop = createPhoneClient(bridge, new Adb());
  const signal = new AbortController().signal;
  return { calls, mcp, desktop,
    async read(path: "mcp" | "desktop") {
      return path === "mcp" ? mcp.callTool({ name: "get_ui_tree", arguments: {} }) : desktop.execute("get_ui_tree", {}, signal);
    },
    async invoke(path: "mcp" | "mcp_nested" | "desktop", action: "tap_element" | "click_element" | "input_text", args: Json): Promise<Json> {
      if (path === "desktop") return desktop.execute("act_and_observe", { action, arguments: args }, signal);
      const response = await mcp.callTool(path === "mcp" ? { name: action, arguments: args }
        : { name: "act_and_observe", arguments: { action, arguments: args } });
      return response.structuredContent as Json;
    },
    async close() { await mcp.close(); await server.close(); await controller.close(); await desktop.close(); },
  };
}

test("explicit label allowances are optional, bounded unique snapshot IDs on tap/click/input only", () => {
  for (const action of ["tap_element", "click_element", "input_text"] as const) {
    const args = { ...target, ...(action === "input_text" ? { text: "合成草稿" } : {}) };
    assert.deepEqual(toolSchemas[action].parse(args), args);
    assert.deepEqual(toolSchemas[action].parse({ ...args, allowedLabelChanges: allowance }).allowedLabelChanges, allowance);
    for (const invalid of [[], ["same", "same"], Array.from({ length: 9 }, (_, i) => `n${i}`), [""], ["x".repeat(65)], [1], "status"]) {
      assert.equal(toolSchemas[action].safeParse({ ...args, allowedLabelChanges: invalid }).success, false);
    }
  }
  assert.equal(toolSchemas.scroll.safeParse({ ...target, direction: "forward", allowedLabelChanges: allowance }).success, false);
  assert.equal(toolSchemas.swipe.safeParse({ snapshotId: target.snapshotId, startX: 1, startY: 2, endX: 3, endY: 4, allowedLabelChanges: allowance }).success, false);
});

test("MCP and desktop schemas advertise the same explicit contract only for supported actions", async () => {
  const h = await harness();
  try {
    const listed = await h.mcp.listTools();
    const desktop = clientTools.find(tool => tool.name === "act_and_observe")!.inputSchema as Json;
    for (const action of ["tap_element", "click_element", "input_text", "scroll", "swipe"]) {
      const mcp = listed.tools.find(tool => tool.name === action)!.inputSchema as Json;
      const nested = desktop.oneOf.find((branch: Json) => branch.properties.action.const === action).properties.arguments as Json;
      const supported = ["tap_element", "click_element", "input_text"].includes(action);
      for (const schema of [mcp, nested]) {
        const field = schema.properties.allowedLabelChanges;
        assert.equal(Boolean(field), supported, action);
        assert.equal(schema.required.includes("allowedLabelChanges"), false);
        if (field) {
          assert.equal(field.type, "array"); assert.equal(field.minItems, 1); assert.equal(field.maxItems, 8);
          assert.match(field.description, /not proof of semantic independence/);
          assert.match(field.description, /recipients, accounts, amounts/);
        }
      }
    }
  } finally { await h.close(); }
});

test("MCP standalone/nested and desktop forward identical allowances once and preserve declared verification", async () => {
  const h = await harness();
  try {
    for (const action of ["tap_element", "click_element", "input_text"] as const) {
      const args = { ...target, allowedLabelChanges: allowance, ...(action === "input_text" ? { text: "合成草稿" } : {}) };
      for (const path of ["mcp", "mcp_nested", "desktop"] as const) {
        await h.read(path === "desktop" ? "desktop" : "mcp");
        const count = h.calls.length;
        const response = await h.invoke(path, action, args);
        assert.equal(response.ok, true);
        assert.equal(h.calls.length, count + 1);
        assert.deepEqual(h.calls.at(-1), { method: "act_and_observe", args: { action, arguments: args, waitMs: 350 } });
        const projected = projectToolResult(response) as Json;
        const result = path === "mcp" ? projected.result : projected.result.action;
        assert.equal(result.contextVerification, "explicit_label_changes");
        assert.equal(result.allowedLabelChangesCount, allowance.length);
      }
    }
    for (const path of ["mcp", "desktop"] as const) {
      await h.read(path);
      const response = await h.invoke(path, "tap_element", target);
      assert.deepEqual(h.calls.at(-1)!.args.arguments, target);
      const result = path === "mcp" ? response.result : response.result.action;
      assert.equal(result.contextVerification, "default_context");
      assert.equal(result.allowedLabelChangesCount, 0);
    }
  } finally { await h.close(); }
});

test("old-phone rejection is propagated without dropping an allowance or retrying the action", async () => {
  const h = await harness(true);
  try {
    for (const path of ["mcp", "mcp_nested", "desktop"] as const) {
      await h.read(path === "desktop" ? "desktop" : "mcp");
      const count = h.calls.length;
      const args = { ...target, allowedLabelChanges: allowance };
      const response = await h.invoke(path, "tap_element", args);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "INVALID_ARGUMENT");
      assert.equal(h.calls.length, count + 1);
      assert.deepEqual(h.calls.at(-1)!.args.arguments, args);
    }
  } finally { await h.close(); }
});

test("model projection exposes only bounded fixed verification metadata, never allowance labels or claims", () => {
  assert.deepEqual(projectToolResult({ action: { accepted: true, contextVerification: "explicit_label_changes", allowedLabelChangesCount: 2,
    allowedLabelChanges: ["Synthetic private label"] } }),
  { action: { accepted: true, contextVerification: "explicit_label_changes", allowedLabelChangesCount: 2 } });
  assert.deepEqual(projectToolResult({ action: { accepted: true, contextVerification: "native_tab_navigation",
    allowedLabelChangesCount: 0, automaticLabelChangesCount: 1, nativeCollection: { private: true } } }),
  { action: { accepted: true, contextVerification: "native_tab_navigation", allowedLabelChangesCount: 0, automaticLabelChangesCount: 1 } });
  for (const count of [-1, 9, 1.5, "2", NaN]) {
    assert.deepEqual(projectToolResult({ contextVerification: "Synthetic arbitrary claim", allowedLabelChangesCount: count, automaticLabelChangesCount: count }), {});
  }
});

test("changed-label facts retain only unique fresh node IDs that survive full-tree projection", () => {
  const status = { ...snapshot.nodes[0], nodeId: "status", parentId: "n0", clickable: false, text: "Synthetic status 2", contentDescription: "" };
  const hiddenLayout = { ...status, nodeId: "empty-layout", text: "", resourceId: "synthetic:id/layout" };
  const tree = { ...snapshot, nodes: [...snapshot.nodes, status, hiddenLayout] };
  const result = projectToolResult({ observation: { ...tree, changedLabelNodeIds: ["status"], labelChangesAreSafe: true,
    changedLabels: [{ text: "Synthetic private extra content" }] } }) as Json;
  assert.deepEqual(result.observation.changedLabelNodeIds, ["status"]);
  assert.equal(result.observation.labelChangesAreSafe, undefined);
  assert.equal(result.observation.changedLabels, undefined);
  assert.equal(result.observation.allowedLabelChanges, undefined);
  for (const invalid of [[], ["status", "status"], ["missing"], ["status", "empty-layout"], [1], [{ nodeId: "status" }], "status",
    ["x".repeat(65)], Array.from({ length: 9 }, (_, i) => `node-${i}`)]) {
    const projected = projectToolResult({ ...tree, changedLabelNodeIds: invalid }) as Json;
    assert.equal(projected.changedLabelNodeIds, undefined);
  }
  assert.equal((projectToolResult({ ...tree, nodes: [...tree.nodes, status], changedLabelNodeIds: ["status"] }) as Json).changedLabelNodeIds, undefined);
  assert.equal((projectToolResult({ nodes: tree.nodes, changedLabelNodeIds: ["status"] }) as Json).changedLabelNodeIds, undefined);
  assert.equal((projectToolResult({ snapshotId: tree.snapshotId, elements: [status], changedLabelNodeIds: ["status"] }) as Json).changedLabelNodeIds, undefined);
});
