import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue } from "../src/approvals.js";
import { createPhoneClient } from "../src/client-tools.js";
import { ToolController, toolSchemas } from "../src/tools.js";
import { snapshot } from "./helpers.js";

type Json = Record<string, any>;
const pixels = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,100,0,100,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,0x3f,0,1,0xff,0xd9]).toString("base64");
const image = (extra: Json = {}) => ({ kind: "screenshot", captureId: "visual-1", packageName: snapshot.packageName,
  windowId: snapshot.windowId, width: 100, height: 100, mimeType: "image/jpeg", source: "window", observationOnly: false,
  actionContract: "visual-tap-v1", expiresInMs: 60000, supportedActions: ["tap_visual", "swipe_visual"], data: pixels, ...extra });
const node = (nodeId: string, extra: Json = {}): Json => ({ ...snapshot.nodes[0], nodeId, parentId: null, text: "", contentDescription: "",
  resourceId: `test:id/${nodeId}`, clickable: false, visible: true, ...extra });
const tree = (nodes: Json[] = [node("root"), node("search", { parentId: "root", text: "Search", clickable: true })], extra: Json = {}): Json =>
  ({ ...snapshot, nodes, observationContract: "semantic-v1", quality: { status: "usable", reason: "accessible_content", readableCount: 1, actionableCount: 1 }, ...extra });
const ok = (result: unknown) => ({ id: "test", ok: true, result, meta: { durationMs: 1 } });
const error = (code: string, details?: Json) => ({ id: "test", ok: false, error: { code, message: "Synthetic refusal", retryable: false, ...(details ? { details } : {}) }, meta: { durationMs: 0 } });
const request = (extra: Json = {}) => ({ selector: { text: "Search" }, operation: "tap", allowScreenshot: true, ...extra });
const value = (reply: Awaited<ReturnType<ToolController["invoke"]>>): Json => reply.structuredContent!;

test("observe_target reads a fresh full native tree and AND-matches a unique target without capturing", async () => {
  const calls: string[] = [];
  const c = new ToolController({ close: async () => {}, call: async (method, params) => {
    calls.push(method); assert.deepEqual(params, { maxNodes: 500, maxDepth: 40 }); return ok(tree());
  } }, new Adb(), new ApprovalQueue(), "trusted");
  try {
    const reply = await c.invoke("observe_target", request({ selector: { textContains: "ear", resourceId: "test:id/search", clickable: true } }));
    assert.equal(value(reply).ok, true);
    assert.deepEqual(value(reply).result.target, { status: "native", operation: "tap", nodeIds: ["search"], reason: "native_target" });
    assert.equal(value(reply).result.observation.snapshotId, snapshot.snapshotId);
    assert.equal(reply.content.some(item => item.type === "image"), false);
    assert.deepEqual(calls, ["get_ui_tree"]);
    assert.equal(toolSchemas.observe_target.safeParse(request({ selector: {} })).success, false);
  } finally { await c.close(); }
});

test("tap resolves a clickable ancestor, scroll returns its nearest scrollable ancestor and read accepts ordinary sensitive verbs", async () => {
  for (const operation of ["tap", "scroll", "read"] as const) {
    const nodes = [node("root"), node("container", { parentId: "root", clickable: true, scrollable: true }),
      node("label", { parentId: "container", text: operation === "read" ? "删除说明" : "Search" })];
    const c = new ToolController({ close: async () => {}, call: async method => { assert.equal(method, "get_ui_tree"); return ok(tree(nodes)); } }, new Adb(), new ApprovalQueue(), "trusted");
    try {
      const target = value(await c.invoke("observe_target", request({ selector: { resourceId: "test:id/label" }, operation }))).result.target;
      assert.equal(target.status, "native");
      assert.deepEqual(target.nodeIds, [operation === "scroll" ? "container" : "label"]);
    } finally { await c.close(); }
  }
});

test("ambiguous, disabled, protected, malformed ancestry and settling targets never trigger screenshots", async () => {
  const scenarios = [
    { nodes: [node("a", { text: "Search", clickable: true }), node("b", { text: "Search", clickable: true })], status: "ambiguous" },
    ...[{ enabled: false }, { visible: false }, { password: true }, { dataSensitive: true }, { nativeSensitive: true },
      { parentId: "absent" }, { parentId: "search" }, { parentId: undefined }, { visible: undefined }]
      .map(patch => ({ nodes: [node("search", { text: "Search", clickable: true, ...patch })], status: "blocked" })),
    { nodes: [node("search", { text: "Search", clickable: true })], status: "blocked", extra: { readiness: { status: "settling", reason: "deadline", samples: 2, waitedMs: 500 } } },
    { nodes: [node("search", { text: "Search", clickable: true })], status: "blocked", extra: { truncated: true } },
  ];
  for (const scenario of scenarios) {
    const c = new ToolController({ close: async () => {}, call: async method => { assert.equal(method, "get_ui_tree"); return ok(tree(scenario.nodes, scenario.extra)); } }, new Adb(), new ApprovalQueue(), "trusted");
    try {
      const reply = value(await c.invoke("observe_target", request()));
      assert.equal(reply.result.target.status, scenario.status, JSON.stringify(scenario));
      assert.deepEqual(reply.result.target.nodeIds, []);
    } finally { await c.close(); }
  }
});

test("missing or non-actionable targets can attach one same-window screenshot while retaining partial native UI", async () => {
  for (const [nodes, status] of [[[], "missing"], [[node("search", { text: "Search" })], "unavailable"]] as const) {
    const calls: string[] = [];
    const c = new ToolController({ close: async () => {}, call: async method => { calls.push(method); return ok(method === "get_ui_tree" ? tree([...nodes]) : image()); } }, new Adb(), new ApprovalQueue(), "trusted");
    try {
      const reply = await c.invoke("observe_target", request());
      assert.equal(value(reply).result.target.status, status);
      assert.equal(value(reply).result.observation.nodes.length, nodes.length);
      assert.equal(value(reply).result.visualObservation.captureId, "visual-1");
      assert.equal(reply.content.filter(item => item.type === "image").length, 1);
      assert.equal(JSON.stringify(reply.structuredContent).includes(pixels), false);
      assert.deepEqual(calls, ["get_ui_tree", "take_screenshot"]);
    } finally { await c.close(); }
  }
});

test("text-only target observation never captures and changed screenshot scope never issues a handle", async () => {
  for (const allowScreenshot of [false, true]) {
    const calls: string[] = [];
    const c = new ToolController({ close: async () => {}, call: async method => { calls.push(method); return ok(method === "get_ui_tree" ? tree([]) : image({ windowId: 99 })); } }, new Adb(), new ApprovalQueue(), "trusted");
    try {
      const reply = await c.invoke("observe_target", request({ allowScreenshot }));
      assert.equal(value(reply).ok, true);
      assert.equal(value(reply).result.visualObservation, undefined);
      assert.equal(reply.content.some(item => item.type === "image"), false);
      assert.equal(value(reply).result.visualObservationError?.code, allowScreenshot ? "SCREENSHOT_CONTEXT_CHANGED" : undefined);
      assert.equal(value(await c.invoke("tap_visual", { captureId: "visual-1", x: 50, y: 50, targetDescription: "Open search" })).error.code, "VISUAL_REFERENCE_INVALID");
      assert.deepEqual(calls, allowScreenshot ? ["get_ui_tree", "take_screenshot"] : ["get_ui_tree"]);
    } finally { await c.close(); }
  }
});

test("MCP and desktop preserve only fixed screenshot failure details in target observation", async () => {
  for (const entry of ["mcp", "desktop"] as const) {
    const calls: string[] = [];
    const bridge = { close: async () => {}, call: async (method: string) => {
      calls.push(method);
      return method === "get_ui_tree" ? ok(tree([])) : { ...error("SCREENSHOT_PROTECTED", { reason: "WINDOW_OBSCURED" }),
        error: { code: "SCREENSHOT_PROTECTED", message: "private-screen-exception", retryable: false, details: { reason: "WINDOW_OBSCURED" } } };
    } };
    const c = entry === "mcp" ? new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted") : undefined;
    const client = entry === "desktop" ? createPhoneClient(bridge, new Adb()) : undefined;
    try {
      const reply: Json = c ? value(await c.invoke("observe_target", request()))
        : await client!.execute("observe_target", request(), new AbortController().signal);
      assert.equal(reply.ok, true);
      assert.equal(reply.result.target.status, "missing");
      assert.deepEqual(reply.result.visualObservationError.details, { reason: "WINDOW_OBSCURED" });
      assert.equal(reply.result.visualObservation, undefined);
      assert.equal(JSON.stringify(reply).includes("private-screen-exception"), false);
      assert.deepEqual(calls, ["get_ui_tree", "take_screenshot"]);
    } finally { await c?.close(); await client?.close(); }
  }
});

test("hard native refusal blocks visual fallback across reads; a confirmed new window or successful native action clears it", async () => {
  for (const reset of ["none", "window", "native"] as const) {
    let refused = false, resetDone = false;
    const calls: string[] = [];
    const c = new ToolController({ close: async () => {}, call: async (method, params) => {
      calls.push(method);
      if (method === "act_and_observe" && params?.action === "press_key") {
        resetDone = true; return ok({ action: { accepted: true }, observation: tree([]) });
      }
      if (method === "act_and_observe") { refused = true; return error("NODE_NOT_ACTIONABLE", { executor: "node-v1", dispatchState: "not_sent" }); }
      const windowId = reset === "window" && refused ? 99 : snapshot.windowId;
      return ok(method === "take_screenshot" ? image({ windowId }) : tree(refused || resetDone ? [] : undefined, { windowId }));
    } }, new Adb(), new ApprovalQueue(), "trusted");
    try {
      await c.invoke("get_ui_tree", {});
      await c.invoke("tap_element", { snapshotId: snapshot.snapshotId, nodeId: "search" });
      if (reset === "native") await c.invoke("press_key", { key: "back" });
      const reply = value(await c.invoke("observe_target", request()));
      assert.equal(reply.result.target.status, reset === "none" ? "blocked" : "missing");
      assert.equal(reply.result.target.reason, reset === "none" ? "prior_refusal" : "not_found");
      assert.equal(calls.filter(method => method === "take_screenshot").length, reset === "none" ? 0 : 1);
    } finally { await c.close(); }
  }
});

test("ordinary stale native references do not lock the target's visual fallback", async () => {
  let refused = false;
  const c = new ToolController({ close: async () => {}, call: async method => {
    if (method === "act_and_observe") { refused = true; return error("TARGET_CHANGED", { executor: "node-v1", dispatchState: "not_sent" }); }
    return ok(method === "take_screenshot" ? image() : tree(refused ? [] : undefined));
  } }, new Adb(), new ApprovalQueue(), "trusted");
  try {
    await c.invoke("get_ui_tree", {});
    await c.invoke("tap_element", { snapshotId: snapshot.snapshotId, nodeId: "search" });
    assert.equal(value(await c.invoke("observe_target", request())).result.visualObservation.captureId, "visual-1");
  } finally { await c.close(); }
});

test("desktop and MCP target observation share native selection and image side-channel semantics", async () => {
  const calls: string[] = [];
  const client = createPhoneClient({ close: async () => {}, call: async method => { calls.push(method); return ok(method === "get_ui_tree" ? tree([]) : image()); } }, new Adb());
  try {
    const reply = await client.execute("observe_target", request(), new AbortController().signal) as Json;
    assert.equal(reply.result.target.status, "missing");
    assert.deepEqual(reply.result.visualObservation.image, { mimeType: "image/jpeg", data: pixels });
    assert.deepEqual(calls, ["get_ui_tree", "take_screenshot"]);
    assert.ok(client.tools.some(tool => tool.name === "observe_target"));
  } finally { await client.close(); }
});
