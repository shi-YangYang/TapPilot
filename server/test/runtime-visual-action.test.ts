import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent } from "../src/runtime/index.js";
import { snapshot } from "./helpers.js";
import { DiagnosticEventSchema } from "../src/diagnostics/schema.js";
import { visualComparison, visualDetails, visualError } from "./visual-refusal-fixture.js";

type Json = Record<string, any>;
const jpeg = (fill = 1) => Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,32,0,32,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,0x3f,0,fill,0xff,0xd9]).toString("base64");
const frame = (captureId = "visual-1", fill = 1, extra: Json = {}) => ({ kind: "screenshot", captureId,
  packageName: snapshot.packageName, windowId: snapshot.windowId, width: 32, height: 32,
  mimeType: "image/jpeg", source: "window", observationOnly: false, actionContract: "visual-tap-v1", expiresInMs: 60000,
  image: { mimeType: "image/jpeg", data: jpeg(fill) }, ...extra });
const tree = (revision = 1, usable = false): Json => ({ ...snapshot, snapshotId: `session:${revision}`, revision,
  observationContract: "semantic-v1", quality: { status: usable ? "usable" : "unavailable", reason: usable ? "accessible_content" : "no_accessible_content", actionableCount: usable ? 1 : 0, readableCount: usable ? 1 : 0 },
  nodes: usable ? snapshot.nodes : [{ ...snapshot.nodes[0], text: "", contentDescription: "", clickable: false }] });
const ok = (result: Json) => ({ ok: true, result });
const action = (captureId = "visual-1", extra: Json = {}) => ({ name: "act_and_observe", args: { action: "tap_visual", arguments: { captureId, x: 16, y: 16, targetDescription: "Open synthetic details", ...extra } } });
const response = (call?: Json) => new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
  role: "assistant", content: call ? null : "Synthetic details are visible", ...(call ? { tool_calls: [{ id: "call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] } : {}) } }] }), { headers: { "Content-Type": "application/json" } });
async function run(plan: (body: Json, turn: number) => Json | undefined,
  perform?: (name: string, args: Json, n: number) => Json, extra: Json = {}) {
  const calls: string[] = [], requests: Json[] = [], diagnostics: Json[] = [];
  let mutations = 0, revision = 0;
  const result = await runAgent({ task: "Open synthetic details", model: { baseUrl: "https://synthetic.invalid/v1", apiKey: "", model: "test", vision: true }, tools: clientTools, ...extra,
    execute: async (name, args) => {
      calls.push(name); if (name === "act_and_observe") mutations++;
      return perform ? perform(name, args, mutations) : ok(name === "take_screenshot" ? frame() : tree(++revision));
    }, modelFetch: async (_url, init) => { const body = JSON.parse(String(init.body)); requests.push(body); return response(plan(body, requests.length)); },
    onDiagnostic: e => { diagnostics.push(e); },
  });
  return { result, calls, requests, diagnostics, mutations };
}
const accepted = (observation: Json, visualObservation?: Json) => ok({ action: { accepted: true },
  execution: { dispatch: "sent", acceptance: "accepted", effect: "unknown", verification: "unverified" }, observation,
  ...(visualObservation ? { visualObservation } : {}) });

test("visual click delivers the next image in the same result, then restores native actions without an extra model read", async () => {
  let revision = 0;
  const out = await run((body, turn) => {
    const offered = body.tools.find((x: Json) => x.function.name === "act_and_observe");
    if (turn <= 2) {
      assert.deepEqual(offered.function.parameters.properties.action.enum, ["tap_visual"]);
      const images = body.messages.filter((x: Json) => Array.isArray(x.content));
      assert.equal(images.length, 1);
      assert.match(images[0].content[0].text, new RegExp(`visual-${turn}`));
      assert.ok(body.messages.filter((x: Json) => x.role === "tool").every((x: Json) => !x.content.includes(jpeg(turn))));
      return action(`visual-${turn}`);
    }
    assert.ok(offered.function.parameters.properties.action.enum.includes("tap_element"));
    assert.ok(!offered.function.parameters.properties.action.enum.includes("tap_visual"));
    assert.ok(body.messages.every((x: Json) => !Array.isArray(x.content)));
  }, (name, _args, n) => name === "take_screenshot" ? ok(frame()) : name === "act_and_observe"
    ? accepted(tree(++revision, n === 2), n === 1 ? frame("visual-2", 2) : undefined) : ok(tree(++revision, n === 2)));
  assert.equal(out.result.status, "completed", out.result.error);
  assert.deepEqual(out.calls, ["get_ui_tree", "wait_for_ui_change", "take_screenshot", "act_and_observe", "act_and_observe", "get_ui_tree"]);
  assert.equal(out.mutations, 2);
  assert.ok(!JSON.stringify(out.diagnostics).includes(jpeg()));
  assert.equal(out.diagnostics.filter(x => x.actionKind === "tap_visual").length, 2);
});

test("same image and point cannot be repeated by changing capture ID or description", async () => {
  const out = await run((_body, turn) => action(`visual-${turn}`, { targetDescription: `Open synthetic item ${turn}` }),
    name => name === "take_screenshot" ? ok(frame()) : name === "act_and_observe" ? accepted(tree(3), frame("visual-2")) : ok(tree()));
  assert.match(out.result.error!, /VISUAL_NO_PROGRESS/); assert.equal(out.mutations, 1);
});

test("old, invented and out-of-bounds image targets are refused before dispatch", async () => {
  for (const input of [action("old"), action("visual-1", { x: 32 }), action("visual-1", { y: 32 })]) {
    const out = await run(() => input);
    assert.equal(out.result.status, "failed"); assert.equal(out.mutations, 0);
  }
});

test("native UI cannot be bypassed with a hidden visual action", async () => {
  const out = await run(body => {
    assert.ok(!body.tools.find((x: Json) => x.function.name === "act_and_observe").function.parameters.properties.action.enum.includes("tap_visual"));
    return action();
  }, () => ok(tree(1, true)));
  assert.match(out.result.error!, /VISUAL_ACTION_UNAVAILABLE/); assert.equal(out.mutations, 0);
});

test("legacy observation-only screenshots cannot authorize a visual click", async () => {
  const { actionContract: _contract, expiresInMs: _expiry, ...legacy } = frame();
  const out = await run(() => action(), name => ok(name === "take_screenshot" ? { ...legacy, observationOnly: true } : tree()));
  assert.match(out.result.error!, /VISUAL_ACTION_UNAVAILABLE/); assert.equal(out.mutations, 0);
});

test("protected or missing post-click image stops without replay or provider image leakage", async () => {
  for (const failure of [undefined, { code: "SCREENSHOT_PROTECTED", message: "private contents" },
    { code: "SCREENSHOT_PROTECTED", message: "private contents", details: { reason: "WINDOW_OBSCURED" } }]) {
    const out = await run(() => action(), name => name === "take_screenshot" ? ok(frame()) : name === "act_and_observe"
      ? { ...accepted(tree(3)), result: { ...accepted(tree(3)).result, ...(failure ? { visualObservationError: failure } : {}) } } : ok(tree()));
    assert.match(out.result.error!, /VISUAL_OBSERVATION_FAILED|SCREENSHOT_PROTECTED/);
    assert.equal(out.mutations, 1); assert.equal(out.requests.length, 1);
    const diagnostic = out.diagnostics.find(x => x.actionKind === "tap_visual");
    assert.equal(diagnostic?.outcome, "failure");
    assert.equal(diagnostic?.failureStage, "observation");
    assert.equal(diagnostic?.dispatchState, "sent");
    assert.equal(diagnostic?.acceptanceState, "accepted");
    assert.equal(diagnostic?.errorCode, failure ? "SCREENSHOT_PROTECTED" : "VISUAL_OBSERVATION_FAILED");
    assert.equal(diagnostic?.reason, failure?.details?.reason ?? "UNKNOWN");
    assert.equal(out.result.errorReason, failure?.details?.reason);
    if (failure) assert.match(out.result.error!, failure.details ? /关闭悬浮窗/ : /未提供具体原因/);
    assert.ok(!JSON.stringify([out.result, out.diagnostics]).includes("private contents"));
  }
});

test("changed post-click image context is discarded and not delivered to model", async () => {
  const out = await run(() => action(), name => name === "take_screenshot" ? ok(frame()) : name === "act_and_observe"
    ? accepted(tree(3), frame("visual-2", 2, { windowId: 999 })) : ok(tree()));
  assert.match(out.result.error!, /SCREENSHOT_CONTEXT_CHANGED/); assert.equal(out.requests.length, 1); assert.equal(out.mutations, 1);
});

test("phone visual refusal is terminal and does not lead to an automatic capture or retry", async () => {
  const out = await run(() => action(), name => name === "take_screenshot" ? ok(frame()) : name === "act_and_observe"
    ? { ok: false, error: { code: "VISUAL_SCENE_CHANGED", message: "Synthetic change" } } : ok(tree()));
  assert.match(out.result.error!, /VISUAL_SCENE_CHANGED/); assert.equal(out.mutations, 1); assert.equal(out.requests.length, 1);
  assert.equal(out.calls.filter(x => x === "take_screenshot").length, 1);
});

test("verified visual scene refusal logs numeric proof and names the changed region without retry", async () => {
  for (const kind of ["both", "local", "dimensions"] as const) {
    const comparison = kind === "dimensions" ? { ...visualComparison(), triggers: ["dimensions"],
      globalChangedPixels: null, globalMeanRgbMilli: null, localPixelCount: null, localChangedPixels: null, localMeanRgbMilli: null }
      : { ...visualComparison(), ...(kind === "local" ? { triggers: ["local_pixels"] } : {}) };
    const out = await run(() => action(), name => name === "take_screenshot" ? ok(frame()) : name === "act_and_observe"
      ? { ok: false, error: { ...visualError(), message: "synthetic-private", details: { ...visualDetails(), visualComparison: comparison } },
        meta: { visualExecutorRefusal: true } } : ok(tree()));
    assert.equal(out.result.status, "failed");
    assert.match(out.result.error!, /VISUAL_SCENE_CHANGED/);
    assert.ok(out.result.error!.includes(kind === "dimensions" ? "截图尺寸已变化" : kind === "local" ? "点击位置附近已变化" : "画面整体及点击位置附近已变化"));
    assert.match(out.result.error!, /点击未发送/);
    assert.equal(out.mutations, 1); assert.equal(out.requests.length, 1);
    assert.equal(out.calls.filter(x => x === "take_screenshot").length, 1);
    const evidence = out.diagnostics.find(x => x.actionKind === "tap_visual");
    assert.equal(evidence?.executor, "visual-tap-v1");
    assert.equal(evidence?.dispatchState, "not_sent");
    assert.equal(evidence?.acceptanceState, "rejected");
    assert.equal(evidence?.failureStage, "phone_validation");
    assert.deepEqual(evidence?.visualComparison, comparison);
    assert.equal(DiagnosticEventSchema.safeParse(evidence).success, true);
    assert.equal(JSON.stringify([out.result, out.diagnostics]).includes("synthetic-private"), false);
  }
});

test("missing or malformed visual proof never claims non-dispatch or triggers native recovery", async () => {
  for (const failure of [
    { error: visualError() },
    { error: { ...visualError(), details: { ...visualDetails(), visualComparison: { ...visualComparison(), x: 9 } } }, meta: { visualExecutorRefusal: true } },
    { error: visualError(), meta: { nativeExecutorRefusal: true } },
    { error: { code: "TARGET_CHANGED", message: "Synthetic", details: { executor: "node-v1", dispatchState: "not_sent" } }, meta: { nativeExecutorRefusal: true } },
  ]) {
    const out = await run(() => action(), name => name === "take_screenshot" ? ok(frame()) : name === "act_and_observe"
      ? { ok: false, ...failure } : ok(tree()));
    assert.equal(out.result.status, "failed");
    assert.doesNotMatch(out.result.error!, /点击未发送/);
    const evidence = out.diagnostics.find(x => x.actionKind === "tap_visual");
    assert.equal(evidence?.executor, undefined);
    assert.equal(evidence?.visualComparison, undefined);
    assert.equal(evidence?.dispatchState, "unknown");
    assert.equal(evidence?.acceptanceState, "unknown");
    assert.equal(out.mutations, 1); assert.equal(out.requests.length, 1);
    assert.equal(out.calls.filter(x => x === "take_screenshot").length, 1);
    assert.equal(out.calls.filter(x => x === "get_ui_tree").length, 1);
  }
});

const swipe = (captureId = "visual-1", extra: Json = {}) => ({ name: "act_and_observe", args: { action: "swipe_visual", arguments: {
  captureId, startX: 25, startY: 16, endX: 6, endY: 16, durationMs: 450, targetDescription: "Scroll synthetic content", ...extra,
} } });
const observe = (allowScreenshot = true) => ({ name: "observe_target", args: { selector: { text: "Synthetic content" }, operation: "scroll", allowScreenshot } });
const targetResult = (status: string, observation: Json, visualObservation?: Json) => ok({ observation,
  target: { status, operation: "scroll", nodeIds: status === "native" ? [snapshot.nodes[0].nodeId] : [], reason: status === "native" ? "native_target" : "not_found" },
  ...(visualObservation ? { visualObservation } : {}),
});
const swipeFrame = (id = "visual-1") => frame(id, 1, { supportedActions: ["tap_visual", "swipe_visual"] });
const actionsOffered = (body: Json) => body.tools.find((t: Json) => t.function.name === "act_and_observe")?.function.parameters.properties.action.enum ?? [];

test("partial native page observes the missing target, permits swipe, and returns to native UI on the next page", async () => {
  let revision = 0;
  const out = await run((body, turn) => {
    if (turn === 1) { assert.ok(!actionsOffered(body).includes("swipe_visual")); return observe(); }
    if (turn === 2) {
      assert.ok(actionsOffered(body).includes("tap_element"));
      assert.ok(actionsOffered(body).includes("swipe_visual"));
      const image = body.messages.find((m: Json) => Array.isArray(m.content));
      assert.match(image.content[0].text, /Native UI is available for some controls/);
      assert.ok(body.messages.some((m: Json) => m.role === "tool" && m.content.includes('"status":"missing"')));
      return swipe();
    }
    assert.ok(actionsOffered(body).includes("tap_element"));
    assert.ok(!actionsOffered(body).includes("swipe_visual"));
    assert.ok(body.messages.every((m: Json) => !Array.isArray(m.content)));
    if (turn === 3) return observe();
  }, (name, _args, n) => name === "observe_target"
    ? targetResult(n ? "native" : "missing", tree(++revision, true), n ? undefined : swipeFrame())
    : name === "act_and_observe" ? accepted(tree(++revision, true)) : ok(tree(++revision, true)));
  assert.equal(out.result.status, "completed", out.result.error);
  assert.deepEqual(out.calls, ["get_ui_tree", "observe_target", "act_and_observe", "observe_target", "get_ui_tree"]);
  assert.equal(out.mutations, 1);
  assert.ok(!JSON.stringify(out.diagnostics).includes(jpeg()));
});

test("visual-only swipe uses returned native UI without another recovery read", async () => {
  const out = await run((body, turn) => {
    if (turn === 1) { assert.deepEqual(actionsOffered(body), ["tap_visual", "swipe_visual"]); return swipe(); }
    assert.ok(actionsOffered(body).includes("scroll"));
    assert.ok(!actionsOffered(body).includes("swipe_visual"));
  }, (name, _args, n) => name === "take_screenshot" ? ok(swipeFrame())
    : name === "act_and_observe" ? accepted(tree(3, true)) : ok(tree(n ? 4 : 1, n > 0)));
  assert.equal(out.result.status, "completed", out.result.error);
  assert.deepEqual(out.calls, ["get_ui_tree", "wait_for_ui_change", "take_screenshot", "act_and_observe", "get_ui_tree"]);
});

test("legacy tap-only capture cannot authorize a hidden visual swipe", async () => {
  const out = await run(body => { assert.ok(!actionsOffered(body).includes("swipe_visual")); return swipe(); });
  assert.match(out.result.error!, /VISUAL_ACTION_UNAVAILABLE/); assert.equal(out.mutations, 0);
});

test("same visual swipe cannot be retried through native partial reads or changed capture IDs and duration", async () => {
  let captures = 0;
  const out = await run((_body, turn) => turn % 2 ? observe() : swipe(`visual-${captures}`, { durationMs: turn === 2 ? 450 : 500, targetDescription: `View item ${turn}` }),
    name => name === "observe_target" ? targetResult("missing", tree(2, true), swipeFrame(`visual-${++captures}`))
      : name === "act_and_observe" ? accepted(tree(3, true)) : ok(tree(1, true)));
  assert.match(out.result.error!, /VISUAL_NO_PROGRESS/); assert.equal(out.mutations, 1); assert.equal(captures, 2);
});

test("blocked target observation discards prior capture and does not capture again", async () => {
  let observations = 0;
  const out = await run((_body, turn) => turn < 3 ? observe() : swipe(), name => name === "observe_target"
    ? targetResult(++observations === 1 ? "missing" : "blocked", tree(2, true), observations === 1 ? swipeFrame() : undefined)
    : ok(tree(1, true)));
  assert.match(out.result.error!, /VISUAL_ACTION_UNAVAILABLE/); assert.equal(out.mutations, 0);
  assert.ok(!out.calls.includes("take_screenshot"));
});

test("text-only target observation never enables screenshots, including hidden true requests", async () => {
  for (const requestImage of [false, true]) {
    const out = await run((body, turn) => {
      const tool = body.tools.find((t: Json) => t.function.name === "observe_target");
      assert.equal(tool.function.parameters.properties.allowScreenshot.const, false);
      if (turn === 1) return observe(requestImage);
    }, name => name === "observe_target" ? targetResult("missing", tree(2, true)) : ok(tree(1, true)),
    { model: { baseUrl: "https://synthetic.invalid/v1", apiKey: "", model: "test", vision: false } });
    assert.equal(out.result.status, requestImage ? "failed" : "completed", out.result.error);
    if (requestImage) { assert.match(out.result.error!, /VISION_REQUIRED/); assert.ok(!out.calls.includes("observe_target")); }
    assert.ok(!out.calls.includes("take_screenshot"));
  }
});

test("target image must match the newly read window, and blocked targets cannot attach actionable images", async () => {
  for (const [status, image] of [["missing", swipeFrame()], ["blocked", swipeFrame()]] as const) {
    const out = await run(() => observe(), name => name === "observe_target"
      ? targetResult(status, { ...tree(2, true), windowId: status === "missing" ? 999 : snapshot.windowId }, image)
      : ok(tree(1, true)));
    assert.match(out.result.error!, /SCREENSHOT_CONTEXT_CHANGED|TOOL_INVALID_RESPONSE/); assert.equal(out.mutations, 0);
    assert.equal(out.requests.length, 1);
  }
});

test("repeated target observations with fresh capture handles cannot keep requesting identical screenshots", async () => {
  let captures = 0;
  const out = await run(() => observe(), name => name === "observe_target"
    ? targetResult("missing", { ...tree(++captures, true), nodes: snapshot.nodes.map((node, index) => ({ ...node, nodeId: `fresh-${captures}-${index}` })) }, swipeFrame(`visual-${captures}`)) : ok(tree(1, true)));
  assert.equal(out.result.status, "failed"); assert.equal(captures, 3); assert.equal(out.mutations, 0);
});

test("target observation cannot share a batch with a mutation based on older evidence", async () => {
  const calls: string[] = [];
  const result = await runAgent({ task: "View synthetic content", model: { baseUrl: "https://synthetic.invalid/v1", apiKey: "", model: "test", vision: true }, tools: clientTools,
    execute: async name => { calls.push(name); return ok(tree(1, true)); },
    modelFetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [observe(), { name: "act_and_observe", args: { action: "press_key", arguments: { key: "back" } } }].map((call, index) => ({ id: `batch-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
    } }] }), { headers: { "Content-Type": "application/json" } }),
  });
  assert.match(result.error!, /UNOBSERVED_ACTION_BATCH/);
  assert.deepEqual(calls, ["get_ui_tree"]);
});
