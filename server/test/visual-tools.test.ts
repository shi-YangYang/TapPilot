import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue, type ApprovalPrompt } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { createPhoneClient, clientTools } from "../src/client-tools.js";
import { AgentError } from "../src/errors.js";
import { PhoneScreenshotSchema, screenshotMetadata } from "../src/screenshot.js";
import { ToolController, toolSchemas } from "../src/tools.js";
import { grant, snapshot } from "./helpers.js";
import { visualDetails, visualError } from "./visual-refusal-fixture.js";

// Synthetic JPEG framing, no real pixels or user data.
const pixels = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9]).toString("base64");
const frame = (captureId = "capture-1") => ({ kind: "screenshot", captureId, packageName: snapshot.packageName,
  windowId: snapshot.windowId, width: 3, height: 2, mimeType: "image/jpeg", source: "window",
  observationOnly: false, actionContract: "visual-tap-v1", expiresInMs: 60_000, data: pixels });
const args = { captureId: "capture-1", x: 1, y: 1, targetDescription: "Open search" };
const ok = (result: unknown) => ({ id: "test", ok: true, result, meta: { durationMs: 0 } });
const tree = (unavailable = false) => ({ ...snapshot, snapshotId: "session:2", revision: 2, observationContract: "semantic-v1",
  quality: unavailable ? { status: "unavailable", reason: "no_accessible_content", readableCount: 0, actionableCount: 0 }
    : { status: "usable", reason: "accessible_content", readableCount: 1, actionableCount: 1 },
  nodes: unavailable ? [] : snapshot.nodes });
const action = (unavailable = false) => ({ action: { action: "tap_visual", accepted: true, executor: "visual-tap-v1", revision: 2 },
  observation: tree(unavailable), execution: { dispatch: "sent", acceptance: "accepted", effect: "unknown", verification: "unverified" } });
const body = (result: Awaited<ReturnType<ToolController["invoke"]>>): any => result.structuredContent;
const trusted = (bridge: PhoneBridge) => new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted");

test("new screenshot contract is strict and old observation-only captures remain compatible", () => {
  assert.equal(PhoneScreenshotSchema.safeParse(frame()).success, true);
  const { actionContract: _contract, expiresInMs: _ttl, ...legacy } = frame();
  assert.equal(PhoneScreenshotSchema.safeParse({ ...legacy, observationOnly: true }).success, true);
  for (const patch of [{ actionContract: undefined }, { expiresInMs: undefined }, { expiresInMs: 60001 },
    { observationOnly: true }, { actionContract: "visual-v2" }, { width: 4 }]) {
    assert.equal(PhoneScreenshotSchema.safeParse({ ...frame(), ...patch }).success, false);
  }
  const metadata = screenshotMetadata(frame());
  assert.equal(metadata?.observationOnly, false);
  assert.equal(metadata && "data" in metadata, false);
  assert.equal(toolSchemas.tap_visual.safeParse({ ...args, x: 0.5 }).success, false);
  assert.equal(toolSchemas.tap_visual.safeParse({ ...args, targetDescription: " " }).success, false);
  const combined = clientTools.find(tool => tool.name === "act_and_observe")!;
  assert.ok(JSON.stringify(combined.inputSchema).includes("tap_visual"));
});

test("latest delivered capture authorizes one bounded visual tap and then returns reusable native UI", async () => {
  const calls: string[] = [];
  const c = trusted({ close: async () => {}, call: async (name, params) => {
    calls.push(name);
    if (name === "take_screenshot") return ok(frame());
    assert.deepEqual(params, { action: "tap_visual", arguments: args, waitMs: 350 });
    return ok(action());
  } });
  try {
    assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_INVALID");
    await c.invoke("take_screenshot", {});
    for (const coordinates of [{ x: 3 }, { y: 2 }, { x: -1 }, { x: 0.5 }]) {
      assert.equal(body(await c.invoke("tap_visual", { ...args, ...coordinates })).error.code, "INVALID_ARGUMENT");
    }
    const reply = body(await c.invoke("tap_visual", args));
    assert.equal(reply.ok, true);
    assert.equal(reply.result.accepted, true);
    assert.equal(reply.result.observation.snapshotId, "session:2");
    assert.equal(reply.result.visualObservation, undefined);
    assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_INVALID");
    assert.deepEqual(calls, ["take_screenshot", "act_and_observe"]);
  } finally { await c.close(); }
});

test("new capture replaces old capability; legacy images and changed windows never authorize visual taps", async () => {
  for (const mode of ["new_capture", "legacy", "window"] as const) {
    let captures = 0;
    const calls: string[] = [];
    const c = trusted({ close: async () => {}, call: async name => {
      calls.push(name);
      if (name === "get_current_app") return ok({ packageName: "other.app", windowId: 99 });
      const value = frame(`capture-${++captures}`);
      if (mode !== "legacy") return ok(value);
      const { actionContract: _contract, expiresInMs: _ttl, ...legacy } = value;
      return ok({ ...legacy, observationOnly: true });
    } });
    try {
      await c.invoke("take_screenshot", {});
      if (mode === "new_capture") await c.invoke("take_screenshot", {});
      if (mode === "window") await c.invoke("get_current_app", {});
      assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_INVALID", mode);
      assert.ok(!calls.includes("act_and_observe"));
    } finally { await c.close(); }
  }
});

test("manual visual approval binds exact capture and arguments, while sensitive descriptions never dispatch", async () => {
  const calls: string[] = [];
  const c = new ToolController({ close: async () => {}, call: async name => {
    calls.push(name); return ok(name === "take_screenshot" ? frame() : action());
  } }, new Adb(), new ApprovalQueue(), "manual");
  try {
    await c.invoke("take_screenshot", {});
    const pending = body(await c.invoke("act_and_observe", { action: "tap_visual", arguments: args }));
    assert.equal(pending.error.code, "CONFIRMATION_REQUIRED");
    const inspected = await grant(pending.error.details as ApprovalPrompt);
    assert.equal(inspected.preview.actionContract, "visual-tap-v1");
    assert.equal(inspected.preview.captureId, args.captureId);
    assert.equal(JSON.stringify(inspected).includes(pixels), false);
    assert.equal(body(await c.invoke("tap_visual", { ...args, x: 2 })).error.code, "CONFIRMATION_REQUIRED");
    assert.equal(body(await c.invoke("act_and_observe", { action: "tap_visual", arguments: args })).ok, true);
    await c.invoke("take_screenshot", {});
    for (const targetDescription of ["发送消息", "确认付款", "Delete item", "Allow permission", "登录账号"]) {
      assert.equal(body(await c.invoke("tap_visual", { ...args, targetDescription })).error.code, "VISUAL_TARGET_UNSAFE");
    }
    assert.deepEqual(calls, ["take_screenshot", "act_and_observe", "take_screenshot"]);
  } finally { await c.close(); }
});

test("capture expires both before action and during asynchronous transport preparation", async t => {
  for (const phase of ["before", "dispatch"] as const) await t.test(phase, async sub => {
    const time = Date.now();
    let now = time, dispatched = 0;
    sub.mock.method(Date, "now", () => now);
    const c = trusted({ close: async () => {}, call: async (name, _params, _timeout, gate) => {
      if (name === "take_screenshot") return ok(frame());
      now = time + 60_001;
      gate?.(); dispatched++;
      return ok(action());
    } });
    try {
      await c.invoke("take_screenshot", {});
      if (phase === "before") now = time + 60_001;
      assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_EXPIRED");
      assert.equal(dispatched, 0);
    } finally { await c.close(); sub.mock.restoreAll(); }
  });
});

test("uncertain mutation transport consumes visual capability without replay", async () => {
  let actions = 0;
  const c = trusted({ close: async () => {}, call: async name => {
    if (name === "take_screenshot") return ok(frame());
    actions++; throw new AgentError("BRIDGE_TIMEOUT", "Synthetic uncertain transport");
  } });
  try {
    await c.invoke("take_screenshot", {});
    assert.equal(body(await c.invoke("tap_visual", args)).error.code, "BRIDGE_TIMEOUT");
    assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_INVALID");
    assert.equal(actions, 1);
  } finally { await c.close(); }
});

test("visual refusal proof survives both tool entrypoints without becoming a native retry authorization", async () => {
  for (const entrypoint of ["tap_visual", "act_and_observe"] as const) {
    const calls: string[] = [];
    const c = trusted({ close: async () => {}, call: async name => {
      calls.push(name);
      return name === "take_screenshot" ? ok(frame()) : { id: "test", ok: false, error: visualError(), meta: { durationMs: 1 } };
    } });
    try {
      await c.invoke("take_screenshot", {});
      const reply = body(await c.invoke(entrypoint, entrypoint === "tap_visual" ? args : { action: "tap_visual", arguments: args }));
      assert.equal(reply.ok, false);
      assert.deepEqual(reply.error, visualError());
      assert.equal(reply.meta.visualExecutorRefusal, true);
      assert.equal(reply.meta.nativeExecutorRefusal, undefined);
      assert.equal(reply.observation, undefined);
      assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_INVALID");
      assert.deepEqual(calls, ["take_screenshot", "act_and_observe"]);
    } finally { await c.close(); }
  }
});

test("malformed visual evidence and native proofs cannot become visual non-dispatch evidence", async () => {
  const errors = [
    { ...visualError(), details: { ...visualDetails(), visualComparison: { ...visualDetails().visualComparison, image: "private" } } },
    { code: "TARGET_CHANGED", message: "Native", retryable: false, details: { executor: "node-v1", dispatchState: "not_sent" } },
  ];
  for (const error of errors) {
    const c = trusted({ close: async () => {}, call: async name => name === "take_screenshot" ? ok(frame()) :
      { id: "test", ok: false, error: error as any, meta: { durationMs: 1 } } });
    try {
      await c.invoke("take_screenshot", {});
      const reply = body(await c.invoke("tap_visual", args));
      assert.equal(reply.error.code, error.code === "TARGET_CHANGED" ? "TARGET_CHANGED" : "BRIDGE_PROTOCOL_ERROR");
      assert.equal(reply.meta.visualExecutorRefusal, undefined);
      assert.equal(reply.meta.nativeExecutorRefusal, undefined);
      assert.equal(reply.observation, undefined);
    } finally { await c.close(); }
  }
});

test("visual action with unavailable UI appends exactly one image, metadata-only JSON and a fresh capability", async () => {
  const calls: string[] = [];
  let captures = 0;
  const c = trusted({ close: async () => {}, call: async name => {
    calls.push(name); return ok(name === "take_screenshot" ? frame(`capture-${++captures}`) : action(captures === 1));
  } });
  try {
    await c.invoke("take_screenshot", {});
    const reply = await c.invoke("act_and_observe", { action: "tap_visual", arguments: args });
    assert.equal(body(reply).ok, true);
    assert.equal(body(reply).result.action.accepted, true);
    assert.equal(body(reply).result.execution.verification, "unverified");
    assert.equal(body(reply).result.visualObservation.captureId, "capture-2");
    assert.equal(reply.content.filter(block => block.type === "image").length, 1);
    assert.equal(JSON.stringify(reply.structuredContent).includes(pixels), false);
    assert.equal(JSON.stringify(reply.content.filter(block => block.type === "text")).includes(pixels), false);
    assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_INVALID");
    assert.equal(body(await c.invoke("tap_visual", { ...args, captureId: "capture-2" })).ok, true);
    assert.deepEqual(calls, ["take_screenshot", "act_and_observe", "take_screenshot", "act_and_observe"]);
  } finally { await c.close(); }
});

test("failed or protected visual follow-up preserves accepted action and never replays", async () => {
  for (const mode of ["protected_observation", "protected_capture", "bad_image", "transport"] as const) {
    let captures = 0;
    const calls: string[] = [];
    const c = trusted({ close: async () => {}, call: async name => {
      calls.push(name);
      if (name !== "take_screenshot") return ok(mode === "protected_observation"
        ? { ...action(true), observationError: { code: "PROTECTED_APP", message: "Synthetic protection" } } : action(true));
      if (++captures === 1) return ok(frame());
      if (mode === "bad_image") return ok({ ...frame("capture-2"), data: "invalid" });
      if (mode === "transport") throw new AgentError("BRIDGE_TIMEOUT", "Synthetic timeout");
      return { id: "test", ok: false, error: { code: "SCREENSHOT_PROTECTED", message: "private-screen-exception", retryable: false,
        details: { reason: "SYSTEM_SECURE_WINDOW" } }, meta: { durationMs: 0 } };
    } });
    try {
      await c.invoke("take_screenshot", {});
      const reply = await c.invoke("act_and_observe", { action: "tap_visual", arguments: args });
      assert.equal(body(reply).ok, true, mode);
      assert.equal(body(reply).result.action.accepted, true, mode);
      assert.equal(reply.content.some(block => block.type === "image"), false, mode);
      if (mode === "protected_observation") assert.equal(captures, 1);
      else {
        assert.equal(captures, 2);
        assert.ok(body(reply).result.visualObservationError);
        if (mode === "protected_capture") assert.deepEqual(body(reply).result.visualObservationError.details, { reason: "SYSTEM_SECURE_WINDOW" });
      }
      assert.equal(JSON.stringify(reply).includes("private-screen-exception"), false);
      assert.equal(body(await c.invoke("tap_visual", args)).error.code, "VISUAL_REFERENCE_INVALID");
      assert.equal(calls.filter(name => name === "act_and_observe").length, 1);
    } finally { await c.close(); }
  }
});

test("desktop exposes follow-up image only under visualObservation.image and preserves cancellation acceptance", async () => {
  for (const cancelled of [false, true]) {
    const abort = new AbortController();
    let captures = 0;
    const client = createPhoneClient({ close: async () => {}, call: async name => {
      if (name !== "take_screenshot") return ok(action(true));
      if (++captures === 2 && cancelled) abort.abort();
      return ok(frame(`capture-${captures}`));
    } }, new Adb());
    try {
      await client.execute("take_screenshot", {}, abort.signal);
      const reply = await client.execute("act_and_observe", { action: "tap_visual", arguments: args }, abort.signal);
      assert.equal(reply.ok, true);
      const value = reply.result as any;
      assert.equal(value.action.accepted, true);
      if (cancelled) {
        assert.equal(value.observationError.code, "CANCELLED");
        assert.equal(JSON.stringify(reply).includes(pixels), false);
      } else {
        assert.deepEqual(value.visualObservation.image, { mimeType: "image/jpeg", data: pixels });
        assert.equal(value.visualObservation.data, undefined);
        assert.equal(value.visualObservation.captureId, "capture-2");
        assert.equal(JSON.stringify(reply.meta).includes(pixels), false);
      }
    } finally { await client.close(); }
  }
});

test("changed follow-up screenshot scope is discarded for MCP and desktop without losing action acceptance", async () => {
  for (const entry of ["mcp", "desktop"] as const) for (const changed of ["package", "window"] as const) {
    let captures = 0, actions = 0;
    const bridge: PhoneBridge = { close: async () => {}, call: async name => {
      if (name !== "take_screenshot") { actions++; return ok(action(true)); }
      if (++captures === 1) return ok(frame());
      return ok({ ...frame("capture-2"), ...(changed === "package" ? { packageName: "another.synthetic.app" } : { windowId: snapshot.windowId + 1 }) });
    } };
    const c = entry === "mcp" ? trusted(bridge) : undefined;
    const client = entry === "desktop" ? createPhoneClient(bridge, new Adb()) : undefined;
    const invoke = async (name: "take_screenshot" | "act_and_observe", params: Record<string, unknown>): Promise<any> => c
      ? body(await c.invoke(name, params)) : client!.execute(name, params, new AbortController().signal);
    try {
      await invoke("take_screenshot", {});
      const reply = await invoke("act_and_observe", { action: "tap_visual", arguments: args });
      assert.equal(reply.ok, true);
      assert.equal(reply.result.action.accepted, true);
      assert.equal(reply.result.execution.verification, "unverified");
      assert.equal(reply.result.visualObservationError.code, "SCREENSHOT_CONTEXT_CHANGED");
      assert.equal(reply.result.visualObservation, undefined);
      assert.equal(JSON.stringify(reply).includes(pixels), false);
      const unissued = await invoke("act_and_observe", { action: "tap_visual", arguments: { ...args, captureId: "capture-2" } });
      assert.equal(unissued.error.code, "VISUAL_REFERENCE_INVALID");
      assert.equal(captures, 2);
      assert.equal(actions, 1);
    } finally { await c?.close(); await client?.close(); }
  }
});

test("emergency stop while the accepted visual action captures its follow-up never publishes pixels or a handle", async () => {
  let captures = 0;
  let stop: Promise<unknown> | undefined;
  let c!: ToolController;
  c = trusted({ close: async () => {}, call: async name => {
    if (name === "emergency_stop") return ok({ stopped: true });
    if (name !== "take_screenshot") return ok(action(true));
    if (++captures === 1) return ok(frame());
    // Exercise the final handoff gate after the transport already returned:
    // emergency stop races with validating the image metadata for delivery.
    const capture = frame("capture-2");
    Object.defineProperty(capture, "captureId", { enumerable: true, get() {
      stop ??= c.invoke("emergency_stop", {});
      return "capture-2";
    } });
    return ok(capture);
  } });
  try {
    await c.invoke("take_screenshot", {});
    const reply = await c.invoke("act_and_observe", { action: "tap_visual", arguments: args });
    await stop;
    assert.equal(body(reply).ok, true);
    assert.equal(body(reply).result.action.accepted, true);
    assert.equal(body(reply).result.visualObservationError.code, "EMERGENCY_STOPPED");
    assert.equal(reply.content.some(block => block.type === "image"), false);
    assert.equal(body(reply).result.visualObservation, undefined);
    assert.equal(JSON.stringify(reply).includes(pixels), false);
    assert.equal(body(await c.invoke("tap_visual", { ...args, captureId: "capture-2" })).error.code, "EMERGENCY_STOPPED");
  } finally { await c.close(); }
});
