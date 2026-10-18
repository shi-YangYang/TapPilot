import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { createPhoneClient } from "../src/client-tools.js";
import { PhoneScreenshotSchema, ScreenshotImageSchema, MAX_SCREENSHOT_BYTES } from "../src/screenshot.js";
import { ToolController } from "../src/tools.js";
import { snapshot } from "./helpers.js";

// Synthetic framing only; native integration verifies an actual Android JPEG. No user pixels.
const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9]).toString("base64");
const screenshot = { kind: "screenshot", captureId: "capture-test", packageName: "dev.test", windowId: 1,
  width: 3, height: 2, mimeType: "image/jpeg", data, source: "window", observationOnly: true };
const ok = (result: unknown) => ({ id: "test", ok: true, result, meta: { durationMs: 0 } });
const controller = (bridge: PhoneBridge) => new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted");

test("bounded JPEG validator rejects corrupt, oversized, dishonest dimensions and action handles", () => {
  assert.equal(PhoneScreenshotSchema.safeParse(screenshot).success, true);
  for (const patch of [{ data: "aGVsbG8=" }, { width: 4 }, { height: 1281 }, { data: data + "\n" },
    { data: Buffer.alloc(MAX_SCREENSHOT_BYTES + 1).toString("base64") }, { snapshotId: "forged" }, { mimeType: "image/png" }]) {
    assert.equal(PhoneScreenshotSchema.safeParse({ ...screenshot, ...patch }).success, false);
  }
  assert.equal(ScreenshotImageSchema.safeParse({ mimeType: "image/jpeg", data }).success, true);
});

test("MCP returns image once with metadata-only JSON and invalidates earlier action references", async () => {
  const calls: string[] = [];
  const c = controller({ close: async () => {}, call: async name => { calls.push(name); return ok(name === "get_ui_tree" ? snapshot : screenshot); } });
  try {
    await c.invoke("get_ui_tree", {});
    const reply = await c.invoke("take_screenshot", {});
    assert.equal(reply.structuredContent?.ok, true);
    assert.equal(reply.content.filter(item => item.type === "image").length, 1);
    assert.equal(JSON.stringify(reply.structuredContent).includes(data), false);
    assert.equal(JSON.stringify(reply.content.filter(item => item.type === "text")).includes(data), false);
    assert.equal((reply.structuredContent?.result as any).snapshotId, undefined);
    assert.equal((await c.invoke("tap_element", { snapshotId: snapshot.snapshotId, nodeId: "n0" })).structuredContent?.ok, false);
    assert.deepEqual(calls, ["get_ui_tree", "take_screenshot"]);
  } finally { await c.close(); }
});

test("desktop shares validation and receives only an in-memory image side channel", async () => {
  const client = createPhoneClient({ close: async () => {}, call: async () => ok(screenshot) }, new Adb());
  try {
    assert.equal(client.tools.some(item => item.name === "take_screenshot"), true);
    const reply = await client.execute("take_screenshot", {}, new AbortController().signal);
    assert.deepEqual((reply.result as any).image, { mimeType: "image/jpeg", data });
    assert.equal((reply.result as any).data, undefined);
    assert.equal((reply.result as any).snapshotId, undefined);
  } finally { await client.close(); }
});

test("protected/old-phone/malformed captures fail without retries or image exposure", async () => {
  for (const error of ["PROTECTED_APP", "SENSITIVE_FIELD", "SCREENSHOT_PROTECTED", "DEVICE_LOCKED", "UNKNOWN_METHOD", "bad_image"]) {
    let count = 0;
    const c = controller({ close: async () => {}, call: async () => {
      count++;
      return error === "bad_image" ? ok({ ...screenshot, data: "bad" }) :
        { id: "test", ok: false, error: { code: error, message: "Capture refused", retryable: false }, meta: { durationMs: 0 } };
    } });
    try {
      const result = await c.invoke("take_screenshot", {});
      assert.equal((result.structuredContent?.error as any).code,
        error === "bad_image" ? "BRIDGE_PROTOCOL_ERROR" : error === "UNKNOWN_METHOD" ? "SCREENSHOT_UNSUPPORTED" : error);
      assert.equal(count, 1);
      assert.equal(result.content.some(item => item.type === "image"), false);
    } finally { await c.close(); }
  }
});

test("capture serialized against actions; emergency stop discards in-flight pixels", async () => {
  let finish!: (value: ReturnType<typeof ok>) => void;
  const c = controller({ close: async () => {}, call: async name => name === "take_screenshot" ?
    new Promise(resolve => { finish = resolve; }) : ok({ stopped: true }) });
  try {
    const pending = c.invoke("take_screenshot", {});
    assert.equal(((await c.invoke("take_screenshot", {})).structuredContent?.error as any).code, "ACTION_IN_PROGRESS");
    assert.equal(((await c.invoke("press_key", { key: "home" })).structuredContent?.error as any).code, "ACTION_IN_PROGRESS");
    await c.invoke("emergency_stop", {});
    finish(ok(screenshot));
    const result = await pending;
    assert.equal((result.structuredContent?.error as any).code, "EMERGENCY_STOPPED");
    assert.equal(result.content.some(item => item.type === "image"), false);
    assert.equal((await c.invoke("take_screenshot", {})).structuredContent?.ok, false);
  } finally { await c.close(); }
});

test("desktop cancellation discards a completed capture before exposing its image", async () => {
  const signal = new AbortController();
  const client = createPhoneClient({ close: async () => {}, call: async () => { signal.abort(); return ok(screenshot); } }, new Adb());
  try {
    const reply = await client.execute("take_screenshot", {}, signal.signal);
    assert.equal((reply.error as any).code, "CANCELLED");
    assert.equal(JSON.stringify(reply).includes(data), false);
  } finally { await client.close(); }
});
