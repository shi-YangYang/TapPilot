import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent } from "../src/runtime/index.js";
import { snapshot } from "./helpers.js";

type Json = Record<string, any>;
type Counts = { captures: number; mutations: number; reads: number };
const jpeg = (fill = 1) => Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,32,0,32,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,0x3f,0,fill,0xff,0xd9]).toString("base64");
const frame = (captureId = "recheck-1", fill = 1, extra: Json = {}) => ({ kind: "screenshot", captureId,
  packageName: snapshot.packageName, windowId: snapshot.windowId, width: 32, height: 32,
  mimeType: "image/jpeg", source: "window", observationOnly: false, actionContract: "visual-tap-v1", expiresInMs: 60000,
  supportedActions: ["tap_visual", "swipe_visual"], image: { mimeType: "image/jpeg", data: jpeg(fill) }, ...extra });
const tree = (revision = 1, usable = false, extra: Json = {}): Json => ({ ...snapshot, snapshotId: `session:${revision}`, revision,
  observationContract: "semantic-v1", quality: { status: usable ? "usable" : "unavailable", reason: usable ? "accessible_content" : "no_accessible_content", actionableCount: usable ? 1 : 0, readableCount: usable ? 1 : 0 },
  nodes: usable ? snapshot.nodes : [{ ...snapshot.nodes[0], text: "", contentDescription: "", clickable: false }], ...extra });
const ok = (result: Json) => ({ ok: true, result });
const accepted = (observation: Json, visualObservation?: Json) => ok({ action: { accepted: true },
  execution: { dispatch: "sent", acceptance: "accepted", effect: "unknown", verification: "unverified" }, observation,
  ...(visualObservation ? { visualObservation } : {}) });
const visual = (kind: "tap_visual" | "swipe_visual" = "tap_visual", captureId = "recheck-1") => ({ name: "act_and_observe", args: {
  action: kind, arguments: { captureId, targetDescription: "View synthetic details",
    ...(kind === "tap_visual" ? { x: 16, y: 16 } : { startX: 25, startY: 16, endX: 6, endY: 16, durationMs: 450 }) },
} });
const recheck = (name: "get_ui_tree" | "wait_for_ui_change") => ({ name, args: name === "get_ui_tree" ? {} : { sinceRevision: 2, timeoutMs: 250 } });
const imageMessages = (body: Json | undefined): Json[] => body?.messages.filter((message: Json) => Array.isArray(message.content)) ?? [];
const imageHandles = (body: Json | undefined) => imageMessages(body).map(message => String(message.content[0]?.text));
const actions = (body: Json) => body.tools.find((tool: Json) => tool.function.name === "act_and_observe")?.function.parameters.properties.action.enum ?? [];
const modelResponse = (call?: Json) => new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
  role: "assistant", content: call ? null : "Synthetic native details are visible", ...(call ? { tool_calls: [{ id: "recheck-call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] } : {}),
} }] }), { headers: { "Content-Type": "application/json" } });

async function run(plan: (turn: number) => Json | undefined, perform: (name: string, args: Json, counts: Counts) => Json) {
  const calls: string[] = [], requests: Json[] = [], diagnostics: Json[] = [];
  const counts: Counts = { captures: 0, mutations: 0, reads: 0 };
  const result = await runAgent({ task: "View synthetic details", maxTurns: 5,
    model: { baseUrl: "https://synthetic.invalid/v1", apiKey: "", model: "test", vision: true }, tools: clientTools,
    execute: async (name, args) => {
      calls.push(name);
      if (name === "take_screenshot") counts.captures++;
      if (name === "act_and_observe") counts.mutations++;
      if (["get_ui_tree", "wait_for_ui_change", "find_element"].includes(name)) counts.reads++;
      return perform(name, args, counts);
    },
    modelFetch: async (_url, init) => { requests.push(JSON.parse(String(init.body))); return modelResponse(plan(requests.length)); },
    onDiagnostic: value => { diagnostics.push(value); },
  });
  return { result, calls, requests, diagnostics, counts };
}

test("same-scope unavailable settling full read or wait preserves the unconsumed image for tap and swipe without recovery/capture", async () => {
  for (const name of ["get_ui_tree", "wait_for_ui_change"] as const) for (const kind of ["tap_visual", "swipe_visual"] as const) {
    const out = await run(turn => turn === 1 ? recheck(name) : turn === 2 ? visual(kind) : undefined,
      (tool, _args, n) => tool === "take_screenshot" ? ok(frame(`recheck-${n.captures}`, n.captures)) : tool === "act_and_observe"
        ? accepted(tree(n.reads + 1, true)) : ok({ ...tree(n.reads, n.mutations > 0,
          // Inaccessible Canvas content cannot establish native interaction readiness.
          // This complete empty tree still belongs to the current visual lease.
          n.mutations === 0 ? { nodes: [], readiness: { status: "settling", reason: "deadline", samples: 3, waitedMs: 2500 } } : {}),
          ...(tool === "wait_for_ui_change" ? { changed: false, timedOut: true } : {}) }));
    assert.equal(out.result.status, "completed", `${name}/${kind}: ${out.result.error}`);
    assert.deepEqual(out.calls, ["get_ui_tree", "wait_for_ui_change", "take_screenshot", name, "act_and_observe", "get_ui_tree"]);
    assert.equal(out.counts.captures, 1); assert.equal(out.counts.mutations, 1);
    for (const name of ["get_current_app", "get_device_info", "navigate_until"]) {
      assert.ok(!out.requests[0]!.tools.some((tool: Json) => tool.function.name === name), "a current image needs no metadata detour or native batch");
    }
    assert.equal(imageMessages(out.requests[1]).length, 1);
    assert.match(imageHandles(out.requests[1])[0]!, /recheck-1/);
    assert.ok(actions(out.requests[1]!).includes(kind));
    assert.equal(imageMessages(out.requests[2]).length, 0, "native recovery removes the image");
    assert.ok(!actions(out.requests[2]!).includes("tap_visual"));
    assert.ok(actions(out.requests[2]!).includes("tap_element"));
    assert.ok(!JSON.stringify(out.diagnostics).includes(jpeg()));
  }
});

test("a native recheck clears the previous image and visual actions without another screenshot", async () => {
  const out = await run(turn => turn === 1 ? recheck("get_ui_tree") : undefined,
    (name, _args, n) => name === "take_screenshot" ? ok(frame()) : ok(tree(n.reads, n.captures > 0)));
  assert.equal(out.result.status, "completed", out.result.error);
  assert.equal(out.requests.length, 2);
  assert.equal(imageMessages(out.requests[0]).length, 1);
  assert.equal(imageMessages(out.requests[1]).length, 0);
  assert.ok(!actions(out.requests[1]!).includes("tap_visual"));
  assert.equal(out.counts.captures, 1); assert.equal(out.counts.mutations, 0);
});

test("scope changes and failed, partial, incomplete or native settling reads never retain the old capture", async () => {
  const invalid: Array<{ label: string; name?: string; result: () => Json }> = [
    { label: "window", result: () => ok(tree(3, false, { windowId: snapshot.windowId + 1 })) },
    { label: "package", result: () => ok(tree(3, false, { packageName: "synthetic.other" })) },
    { label: "session", result: () => ok(tree(3, false, { snapshotId: "new-session:3" })) },
    { label: "read-error", result: () => ({ ok: false, error: { code: "ANDROID_ERROR", message: "Synthetic read error" } }) },
    { label: "partial", name: "find_element", result: () => ok({ snapshotId: "session:3", revision: 3, packageName: snapshot.packageName, windowId: snapshot.windowId, elements: [] }) },
    { label: "truncated", result: () => ok(tree(3, false, { truncated: true })) },
    { label: "incomplete", result: () => { const { truncated: _truncated, ...incomplete } = tree(3); return ok(incomplete); } },
    { label: "native-settling", result: () => ok(tree(3, true, { readiness: { status: "settling", reason: "deadline", samples: 2, waitedMs: 2500 } })) },
  ];
  for (const scenario of invalid) {
    const out = await run(turn => turn === 1
      ? scenario.name === "find_element" ? { name: "find_element", args: { selector: { text: "Synthetic missing" } } } : recheck("get_ui_tree")
      : visual(), (name, _args, n) => name === "take_screenshot" ? ok(frame(`recheck-${n.captures}`, n.captures))
        : n.captures > 0 ? scenario.result() : ok(tree(n.reads)));
    assert.equal(out.counts.mutations, 0, scenario.label);
    assert.equal(out.result.status, "failed", scenario.label);
    assert.ok(out.calls.includes(scenario.name ?? "get_ui_tree"), scenario.label);
    for (const request of out.requests.slice(1)) assert.ok(imageHandles(request).every(text => !text.includes('"captureId":"recheck-1"')), scenario.label);
  }
});

test("an unchanged recheck preserves the original expiry instead of renewing its 60 second lifetime", async t => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  const out = await run(turn => {
    if (turn === 1) { now += 59_000; return recheck("get_ui_tree"); }
    now += 2_000;
    return visual();
  }, (name, _args, n) => name === "take_screenshot" ? ok(frame(`recheck-${n.captures}`, n.captures)) : ok(tree(n.reads)));
  assert.equal(out.counts.captures, 1, "the recheck must not create a new lease");
  assert.equal(out.requests.length, 2);
  assert.match(imageHandles(out.requests[1])[0]!, /recheck-1/, "the original image is still valid at 59 seconds");
  assert.equal(out.counts.mutations, 0);
  assert.match(out.result.error!, /VISUAL_ACTION_UNAVAILABLE|VISUAL_REFERENCE_EXPIRED/);

  now = 1_700_000_000_000;
  const expired = await run(turn => {
    if (turn === 1) { now += 61_000; return recheck("get_ui_tree"); }
    return visual();
  }, (name, _args, n) => name === "take_screenshot" ? ok(frame(`recheck-${n.captures}`, n.captures)) : ok(tree(n.reads)));
  assert.equal(expired.counts.mutations, 0, "an already expired capture cannot return through a read");
  assert.equal(expired.result.status, "failed");
  for (const request of expired.requests.slice(1)) assert.ok(imageHandles(request).every(text => !text.includes('"captureId":"recheck-1"')));
});

test("rechecking the post-action unavailable tree cannot restore the consumed capture", async () => {
  const out = await run(turn => turn === 1 ? visual() : turn === 2 ? recheck("get_ui_tree") : visual(),
    (name, _args, n) => name === "take_screenshot" ? ok(frame(`recheck-${n.captures}`, n.captures))
      : name === "act_and_observe" ? accepted(tree(3), frame("post-action", 2)) : ok(tree(n.reads)));
  assert.equal(out.counts.mutations, 1);
  assert.equal(out.counts.captures, 1);
  assert.equal(out.requests.length, 3);
  assert.match(imageHandles(out.requests[2])[0]!, /post-action/);
  assert.ok(imageHandles(out.requests[2]).every(text => !text.includes('"captureId":"recheck-1"')));
  assert.match(out.result.error!, /VISUAL_ACTION_UNAVAILABLE/);
});
