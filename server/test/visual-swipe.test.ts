import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue, type ApprovalPrompt } from "../src/approvals.js";
import { createPhoneClient, clientTools } from "../src/client-tools.js";
import { PhoneScreenshotSchema, screenshotMetadata } from "../src/screenshot.js";
import { ToolController, toolSchemas } from "../src/tools.js";
import { DiagnosticEventSchema, createDiagnosticRunId } from "../src/diagnostics/schema.js";
import { grant, snapshot } from "./helpers.js";
import { visualComparison, visualError } from "./visual-refusal-fixture.js";

type Json = Record<string, any>;
const pixels = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,100,0,100,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,0x3f,0,1,0xff,0xd9]).toString("base64");
const frame = (extra: Json = {}) => ({ kind: "screenshot", captureId: "visual-1", packageName: snapshot.packageName,
  windowId: snapshot.windowId, width: 100, height: 100, mimeType: "image/jpeg", source: "window", observationOnly: false,
  actionContract: "visual-tap-v1", expiresInMs: 60000, supportedActions: ["tap_visual", "swipe_visual"], data: pixels, ...extra });
const args = { captureId: "visual-1", startX: 50, startY: 80, endX: 50, endY: 20, targetDescription: "Scroll to view more items" };
const ok = (result: unknown) => ({ id: "test", ok: true, result, meta: { durationMs: 1 } });
const observed = (unavailable = false) => ({ ...snapshot, observationContract: "semantic-v1",
  quality: { status: unavailable ? "unavailable" : "usable", reason: unavailable ? "no_accessible_content" : "accessible_content",
    readableCount: unavailable ? 0 : 1, actionableCount: unavailable ? 0 : 1 }, nodes: unavailable ? [] : snapshot.nodes });
const accepted = (unavailable = false) => ({ action: { action: "swipe_visual", accepted: true, executor: "visual-tap-v1" },
  execution: { dispatch: "sent", acceptance: "accepted", effect: "unknown", verification: "unverified" }, observation: observed(unavailable) });
const value = (reply: Awaited<ReturnType<ToolController["invoke"]>>): Json => reply.structuredContent!;

test("swipe capability is explicit and unique; legacy captures remain tap-only", async () => {
  assert.equal(PhoneScreenshotSchema.safeParse(frame()).success, true);
  assert.deepEqual(screenshotMetadata(frame())?.observationOnly === false && (screenshotMetadata(frame()) as any).supportedActions, ["tap_visual", "swipe_visual"]);
  for (const supportedActions of [[], ["swipe_visual"], ["tap_visual", "tap_visual"], ["tap_visual", "arbitrary_action"]]) {
    assert.equal(PhoneScreenshotSchema.safeParse(frame({ supportedActions })).success, false);
  }
  for (const supportedActions of [undefined, ["tap_visual"]]) {
    let mutations = 0;
    const c = new ToolController({ close: async () => {}, call: async method => {
      if (method !== "take_screenshot") mutations++;
      return ok(method === "take_screenshot" ? frame({ supportedActions }) : accepted());
    } }, new Adb(), new ApprovalQueue(), "trusted");
    try {
      await c.invoke("take_screenshot", {});
      assert.equal(value(await c.invoke("swipe_visual", args)).error.code, "VISUAL_ACTION_UNSUPPORTED");
      assert.equal(mutations, 0);
      assert.equal(value(await c.invoke("tap_visual", { captureId: "visual-1", x: 50, y: 50, targetDescription: "Open item" })).ok, true);
    } finally { await c.close(); }
  }
});

test("visual swipe validates integer bounds, edge margin, distance and duration before one defaulted dispatch", async () => {
  let mutations = 0;
  const c = new ToolController({ close: async () => {}, call: async (method, params) => {
    if (method === "take_screenshot") return ok(frame());
    mutations++; assert.deepEqual(params, { action: "swipe_visual", arguments: { ...args, durationMs: 450 }, waitMs: 350 }); return ok(accepted());
  } }, new Adb(), new ApprovalQueue(), "trusted");
  try {
    await c.invoke("take_screenshot", {});
    for (const patch of [{ startX: 0 }, { endY: 100 }, { endX: 50.5 }, { endY: 79 }, { durationMs: 199 }, { durationMs: 1001 }]) {
      assert.equal(value(await c.invoke("swipe_visual", { ...args, ...patch })).error.code, "INVALID_ARGUMENT");
    }
    assert.equal(value(await c.invoke("swipe_visual", args)).ok, true);
    assert.equal(value(await c.invoke("tap_visual", { captureId: "visual-1", x: 50, y: 50, targetDescription: "Open item" })).error.code, "VISUAL_REFERENCE_INVALID");
    assert.equal(mutations, 1);
  } finally { await c.close(); }
  assert.equal(toolSchemas.swipe_visual.parse(args).durationMs, 450);
  assert.ok(JSON.stringify(clientTools.find(tool => tool.name === "act_and_observe")?.inputSchema).includes("swipe_visual"));
});

test("manual swipe approval binds the exact path and sensitive gestures remain blocked", async () => {
  let mutations = 0;
  const c = new ToolController({ close: async () => {}, call: async method => {
    if (method === "take_screenshot") return ok(frame());
    mutations++; return ok(accepted());
  } }, new Adb(), new ApprovalQueue(), "manual");
  try {
    await c.invoke("take_screenshot", {});
    const pending = value(await c.invoke("swipe_visual", args));
    assert.equal(pending.error.code, "CONFIRMATION_REQUIRED");
    const inspected = await grant(pending.error.details as ApprovalPrompt);
    assert.deepEqual(inspected.preview.imageGesture, { startX: 50, startY: 80, endX: 50, endY: 20, durationMs: 450 });
    assert.equal(value(await c.invoke("swipe_visual", { ...args, endY: 30 })).error.code, "CONFIRMATION_REQUIRED");
    assert.equal(value(await c.invoke("act_and_observe", { action: "swipe_visual", arguments: args })).ok, true);
    await c.invoke("take_screenshot", {});
    assert.equal(value(await c.invoke("swipe_visual", { ...args, targetDescription: "Swipe to confirm payment" })).error.code, "VISUAL_TARGET_UNSAFE");
    assert.equal(mutations, 1);
  } finally { await c.close(); }
});

test("MCP and desktop return native UI after swipe, or one same-result image if UI is unavailable", async () => {
  for (const entrypoint of ["mcp", "desktop"] as const) {
    let captures = 0, mutations = 0;
    const bridge = { close: async () => {}, call: async (method: string) => {
      if (method === "take_screenshot") return ok(frame({ captureId: `visual-${++captures}` }));
      mutations++; return ok(accepted(true));
    } };
    if (entrypoint === "mcp") {
      const c = new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted");
      try {
        await c.invoke("take_screenshot", {});
        const reply = await c.invoke("swipe_visual", args);
        assert.equal(value(reply).result.accepted, true);
        assert.equal(value(reply).result.visualObservation.captureId, "visual-2");
        assert.equal(reply.content.filter(item => item.type === "image").length, 1);
        assert.equal(JSON.stringify(reply.structuredContent).includes(pixels), false);
      } finally { await c.close(); }
    } else {
      const client = createPhoneClient(bridge, new Adb());
      try {
        await client.execute("take_screenshot", {}, new AbortController().signal);
        const reply = await client.execute("act_and_observe", { action: "swipe_visual", arguments: args }, new AbortController().signal) as Json;
        assert.equal(reply.result.action.accepted, true);
        assert.equal(reply.result.visualObservation.captureId, "visual-2");
        assert.deepEqual(reply.result.visualObservation.image, { mimeType: "image/jpeg", data: pixels });
      } finally { await client.close(); }
    }
    assert.equal(mutations, 1); assert.equal(captures, 2);
  }
});

test("visual swipe refusal keeps independent not-sent evidence and never captures or dispatches twice", async () => {
  const calls: string[] = [];
  const c = new ToolController({ close: async () => {}, call: async method => {
    calls.push(method); return method === "take_screenshot" ? ok(frame()) : { id: "test", ok: false, error: visualError(), meta: { durationMs: 1 } };
  } }, new Adb(), new ApprovalQueue(), "trusted");
  try {
    await c.invoke("take_screenshot", {});
    const reply = value(await c.invoke("act_and_observe", { action: "swipe_visual", arguments: args }));
    assert.deepEqual(reply.error, visualError());
    assert.equal(reply.meta.visualExecutorRefusal, true); assert.equal(reply.meta.nativeExecutorRefusal, undefined);
    assert.equal(value(await c.invoke("swipe_visual", args)).error.code, "VISUAL_REFERENCE_INVALID");
    assert.deepEqual(calls, ["take_screenshot", "act_and_observe"]);
  } finally { await c.close(); }
  assert.equal(DiagnosticEventSchema.safeParse({ schemaVersion: 1, eventType: "tool_result", runId: createDiagnosticRunId(), timestamp: 1000,
    stepIndex: 1, actionKind: "swipe_visual", executor: "visual-tap-v1", outcome: "failure", failureStage: "phone_validation", dispatchState: "not_sent",
    acceptanceState: "rejected", effectState: "unknown", errorCode: "VISUAL_SCENE_CHANGED", reason: "UNKNOWN", visualComparison: visualComparison(), versions: { host: "0.3.19" } }).success, true);
});
