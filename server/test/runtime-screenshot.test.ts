import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { clientTools } from "../src/client-tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";
import { completion, type Message } from "../src/runtime/model.js";
import { Conversation } from "../src/runtime/context.js";
import { snapshot } from "./helpers.js";
import { modelScope } from "../src/learning/schema.js";
import { SkillSpecSchema, SKILL_POLICY_REVISION } from "../src/skills/schema.js";
import { screenshotFailureReasons } from "../src/screenshot-errors.js";

type Json = Record<string, any>;
const jpeg = (padding = 0, fill = 0) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 32, 0, 32, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(padding + 1, fill), Buffer.from([0xff, 0xd9]),
]).toString("base64");
const pixels = { mimeType: "image/jpeg" as const, data: jpeg() };
const metadata = { kind: "screenshot", captureId: "synthetic-capture", packageName: snapshot.packageName, windowId: snapshot.windowId,
  width: 32, height: 32, mimeType: "image/jpeg", source: "window", observationOnly: true };
const imageResult = () => ({ ...metadata, image: { ...pixels } });
const tree = (revision = 1, unavailable = true): Json => ({ ...snapshot, snapshotId: `session:${revision}`, revision,
  observationContract: "semantic-v1", quality: unavailable ? { status: "unavailable", reason: "no_accessible_content", actionableCount: 0, readableCount: 0 }
    : { status: "usable", reason: "accessible_content", actionableCount: 1, readableCount: 1 },
  nodes: unavailable ? [{ ...snapshot.nodes[0], text: "", contentDescription: "", clickable: false }] : snapshot.nodes,
});
const ok = (result: Json) => ({ ok: true, result });
const model = { baseUrl: "https://synthetic.invalid/v1", model: "synthetic-model", apiKey: "", vision: true };
const answer = (calls?: Json[]) => new Response(JSON.stringify({ choices: [{ finish_reason: calls ? "tool_calls" : "stop", message: {
  role: "assistant", content: calls ? null : "Synthetic screenshot description; interaction requires an accessible control.",
  ...(calls ? { tool_calls: calls.map((call, index) => ({ id: `synthetic_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } : {}),
} }], usage: { total_tokens: 1 } }), { headers: { "Content-Type": "application/json" } });
async function run(plan: (body: Json, index: number) => Response = () => answer(),
  implementation?: AgentOptions["execute"], extra: Partial<AgentOptions> = {}) {
  const requests: Json[] = [], events: Json[] = [], diagnostics: Json[] = [], traces: Json[] = [], calls: string[] = [];
  let revision = 0;
  const result = await runAgent({ task: "Read the synthetic screen", tools: clientTools, model, ...extra,
    execute: async (name, args, signal) => { calls.push(name); return implementation ? implementation(name, args, signal)
      : ok(name === "take_screenshot" ? imageResult() : name === "get_current_app" ? { packageName: snapshot.packageName, windowId: snapshot.windowId } : tree(++revision)); },
    modelFetch: async (_url, init) => { const body = JSON.parse(String(init.body)); requests.push(body); return plan(body, requests.length - 1); },
    onEvent: event => events.push(event), onDiagnostic: event => { diagnostics.push(event); }, onSkillTrace: trace => { traces.push(trace); },
  });
  return { result, calls, requests, events, diagnostics, traces };
}

test("unavailable UI gets one recovery and one image; model sees read-only tools and diagnostics never contain pixels", async () => {
  const output = await run(body => {
    assert.ok(body.tools.every((tool: Json) => !["act_and_observe", "take_screenshot"].includes(tool.function.name)));
    const images = body.messages.filter((message: Json) => Array.isArray(message.content));
    assert.equal(images.length, 1);
    assert.equal(images[0].content[1].image_url.url, `data:image/jpeg;base64,${pixels.data}`);
    assert.equal(images[0].image, undefined);
    for (const message of body.messages.filter((message: Json) => message.role === "tool")) assert.ok(!message.content.includes(pixels.data));
    return answer();
  });
  assert.equal(output.result.status, "completed", output.result.error);
  assert.deepEqual(output.calls, ["get_ui_tree", "wait_for_ui_change", "take_screenshot", "get_ui_tree"]);
  assert.equal(output.requests.length, 1);
  assert.equal(output.diagnostics.find(entry => entry.actionKind === "take_screenshot")?.outcome, "success");
  assert.ok(!JSON.stringify([output.events, output.diagnostics, output.traces, output.result]).includes(pixels.data));
});

test("text models stop descriptively after native recovery without taking or sending images", async () => {
  const output = await run(() => { throw new Error("No model request expected"); }, undefined, { model: { ...model, vision: false } });
  assert.equal(output.result.status, "failed"); assert.match(output.result.error!, /VISION_REQUIRED/);
  assert.deepEqual(output.calls, ["get_ui_tree", "wait_for_ui_change"]);
  assert.equal(output.requests.length, 0);
});

test("automatic screenshot failures retain fixed reasons through UI events and final diagnostics without raw prose", async () => {
  const labels = ["关闭悬浮窗", "Android 将当前窗口标记为禁止截图", "Android 拒绝了截图访问", "密码或敏感控件", "无法完整确认", "当前窗口类型不支持"];
  const pairs = [...screenshotFailureReasons.map((reason, index) => ({ code: "SCREENSHOT_PROTECTED", reason, label: labels[index]! })),
    { code: "SCREENSHOT_UNAVAILABLE", reason: "SCREENSHOT_ACCESS_DENIED", label: "Android 拒绝了截图访问" },
    { code: "SENSITIVE_FIELD", reason: "SENSITIVE_NODE", label: "密码或敏感控件" }];
  for (const { code, reason, label } of pairs) {
    const output = await run(() => { throw new Error("No model request expected"); }, async name => name === "take_screenshot"
      ? { ok: false, error: { code, message: "PRIVATE_SCREEN_OR_EXCEPTION_TEXT", retryable: false, details: { reason } } } : ok(tree()));
    assert.equal(output.result.status, "failed", reason);
    assert.equal(output.result.errorReason, reason);
    assert.ok(output.result.error!.includes(label), output.result.error);
    assert.equal(output.requests.length, 0);
    assert.equal(output.calls.filter(name => name === "take_screenshot").length, 1);
    assert.equal(output.diagnostics.find(event => event.actionKind === "take_screenshot")?.reason, reason);
    assert.equal(output.diagnostics.find(event => event.eventType === "run_finished")?.reason, reason);
    assert.equal(output.events.find(event => event.type === "tool_end" && event.toolName === "take_screenshot")?.errorReason, reason);
    assert.equal(JSON.stringify([output.result, output.events, output.diagnostics, output.traces]).includes("PRIVATE_SCREEN_OR_EXCEPTION_TEXT"), false);
  }
});

test("legacy and invalid screenshot reasons stay unknown while timeout/rate/context messages remain specific", async () => {
  for (const [code, details, label] of [
    ["SCREENSHOT_PROTECTED", undefined, "未提供具体原因"],
    ["SCREENSHOT_PROTECTED", { reason: "PRIVATE_REASON" }, "未提供具体原因"],
    ["SCREENSHOT_PROTECTED", { reason: "WINDOW_OBSCURED", private: "PRIVATE_REASON" }, "未提供具体原因"],
    ["SCREENSHOT_TIMEOUT", { reason: "SYSTEM_SECURE_WINDOW" }, "截图请求超时"],
    ["SCREENSHOT_RATE_LIMITED", undefined, "截图请求过于频繁"],
    ["SCREENSHOT_CONTEXT_CHANGED", undefined, "页面已切换"],
  ] as const) {
    const output = await run(() => { throw new Error("No model request expected"); }, async name => name === "take_screenshot"
      ? { ok: false, error: { code, message: "PRIVATE_REASON", ...(details ? { details } : {}) } } : ok(tree()));
    assert.equal(output.result.errorReason, undefined);
    assert.ok(output.result.error!.includes(label), output.result.error);
    assert.equal(output.diagnostics.find(event => event.actionKind === "take_screenshot")?.reason, "UNKNOWN");
    assert.equal(output.diagnostics.find(event => event.eventType === "run_finished")?.reason, "UNKNOWN");
    assert.equal(JSON.stringify([output.result, output.events, output.diagnostics]).includes("PRIVATE_REASON"), false);
  }
});

test("target-observation screenshot failures keep the reason and do not trigger another capture", async () => {
  for (const reason of [undefined, "WINDOW_OBSCURED"] as const) {
    const output = await run(() => answer([{ name: "observe_target", args: { selector: { text: "Missing" }, operation: "tap", allowScreenshot: true } }]),
    async name => name === "observe_target" ? ok({ observation: tree(2, false),
      target: { status: "missing", operation: "tap", nodeIds: [], reason: "not_found" },
      visualObservationError: { code: "SCREENSHOT_PROTECTED", message: "PRIVATE_SCREEN_TEXT", retryable: false, ...(reason ? { details: { reason } } : {}) } })
      : ok(tree(1, false)));
    assert.equal(output.result.errorReason, reason);
    assert.match(output.result.error!, reason ? /关闭悬浮窗/ : /未提供具体原因/);
    assert.deepEqual(output.calls, ["get_ui_tree", "observe_target"]);
    assert.equal(output.diagnostics.find(event => event.actionKind === "observe_target")?.reason, reason ?? "UNKNOWN");
    assert.equal(JSON.stringify([output.result, output.events, output.diagnostics]).includes("PRIVATE_SCREEN_TEXT"), false);
  }
});

test("usable native UI and recoverable native UI never take screenshots", async () => {
  for (const startsUnavailable of [false, true]) {
    let count = 0;
    const output = await run(() => answer(), async () => ok(tree(++count, startsUnavailable && count === 1)));
    assert.equal(output.result.status, "completed", output.result.error);
    assert.ok(!output.calls.includes("take_screenshot"));
    assert.ok(output.requests.every(body => body.messages.every((message: Json) => !Array.isArray(message.content))));
  }
});

test("preventive sampling preserves a capable phone's readiness recovery before screenshot fallback", async () => {
  for (const capable of [true, false]) for (const vision of [true, false]) {
    const configured = { ...model, vision };
    const skill = SkillSpecSchema.parse({ schemaVersion: 1,
      scope: { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: modelScope(configured).modelProfile,
        appDigest: createHash("sha256").update(snapshot.packageName).digest("hex") },
      trigger: { errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", actionKind: "input_text" },
      entryConditions: [], program: { entry: 0, nodes: [{ kind: "step", operation: { op: "observe", mode: "reuse_latest" }, next: 1 }, { kind: "end", outcome: "continue" }] },
      prevention: { entryConditions: [{ fact: "observedLabelChanges", test: "eq", value: "yes" }], program: { entry: 0, nodes: [
        { kind: "step", operation: { op: "inspect_changed_labels" }, next: 1 }, { kind: "step", operation: { op: "allow_unrelated_status_labels" }, next: 2 },
        { kind: "end", outcome: "continue" }] } }, lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 60_000 });
    let reads = 0;
    const output = await run(body => {
      assert.ok(capable || vision, "legacy unavailable UI requires a vision model");
      assert.equal(body.messages.filter((message: Json) => Array.isArray(message.content)).length, capable ? 0 : 1);
      return answer();
    }, async (name, args) => {
      if (name === "take_screenshot") return ok(imageResult());
      reads++;
      if (capable && reads === 3) assert.equal(args.requireUsable, true, "a preventive sample is not the readiness recovery");
      return ok({ ...tree(reads, reads > 1 && (!capable || reads === 2)),
        ...(capable ? { observationCapabilities: { readinessWait: true } } : {}) });
    },
    { model: configured, diagnosticVersion: "0.3.19", skillSnapshot: [skill] });
    assert.equal(output.result.status, capable || vision ? "completed" : "failed", output.result.error);
    assert.deepEqual(output.calls, capable ? ["get_ui_tree", "wait_for_ui_change", "wait_for_ui_change", "get_ui_tree"]
      : vision ? ["get_ui_tree", "wait_for_ui_change", "take_screenshot", "get_ui_tree"] : ["get_ui_tree", "wait_for_ui_change"]);
    assert.equal(output.requests.length, capable || vision ? 1 : 0);
    if (!capable && !vision) assert.match(output.result.error!, /VISION_REQUIRED/);
  }
});

test("screenshot evidence never authorizes mutations, including tools omitted from the decision list", async () => {
  const output = await run(() => answer([{ name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } }]));
  assert.match(output.result.error!, /VISUAL_OBSERVATION_ONLY/);
  assert.deepEqual(output.calls, ["get_ui_tree", "wait_for_ui_change", "take_screenshot"]);
});

test("partial queries may expire image evidence but cannot release the visual-only mutation lock", async () => {
  const output = await run((body, index) => {
    assert.ok(body.tools.every((tool: Json) => tool.function.name !== "act_and_observe"));
    return answer(index === 0 ? [{ name: "find_element", args: { selector: { text: "Synthetic missing target" } } }]
      : [{ name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } }]);
  }, async name => ok(name === "take_screenshot" ? imageResult() : name === "find_element" ? { snapshotId: "session:3", revision: 3, elements: [] } : tree()));
  assert.match(output.result.error!, /VISUAL_OBSERVATION_ONLY/);
  assert.deepEqual(output.calls, ["get_ui_tree", "wait_for_ui_change", "take_screenshot", "find_element"]);
  assert.ok(output.requests[1]!.messages.every((message: Json) => !Array.isArray(message.content)));
});

test("an accepted action with unknown effect gets screenshot observation without replaying or upgrading verification", async () => {
  let reads = 0;
  const output = await run((_body, index) => index === 0 ? answer([{ name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: "session:1", nodeId: "n0" } } }]) : answer(),
    async name => {
      if (name === "take_screenshot") return ok(imageResult());
      if (name === "act_and_observe") return ok({ action: { accepted: true }, execution: { dispatch: "sent", acceptance: "accepted", effect: "unknown", verification: "unverified" }, observation: tree(2) });
      return ok(tree(++reads, reads > 1));
    });
  assert.equal(output.result.status, "completed", output.result.error);
  assert.deepEqual(output.calls, ["get_ui_tree", "act_and_observe", "wait_for_ui_change", "take_screenshot", "get_ui_tree"]);
  assert.equal(output.diagnostics.find(entry => entry.actionKind === "tap_element").effectState, "unknown");
  const toolFacts = output.requests[1]!.messages.filter((message: Json) => message.role === "tool").map((message: Json) => message.content).join("\n");
  assert.ok(!toolFacts.includes('"verification":"verified"'));
});

test("separate inaccessible episodes retain one image and cap the whole task at three captures", async () => {
  let unavailable = false;
  let revision = 0;
  const output = await run((body, index) => {
    assert.equal(body.messages.filter((message: Json) => Array.isArray(message.content)).length, index % 2);
    return answer(index % 2 === 0 ? [{ name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: `session:${revision}`, nodeId: "n0" } } }] : [{ name: "get_ui_tree" }]);
  }, async name => {
    if (name === "take_screenshot") return ok(imageResult());
    if (name === "act_and_observe") {
      unavailable = true;
      return ok({ action: { accepted: true }, execution: { dispatch: "sent", acceptance: "accepted", effect: "unknown", verification: "unverified" }, observation: tree(++revision) });
    }
    if (name === "get_ui_tree") unavailable = false;
    return ok(tree(++revision, unavailable));
  });
  assert.match(output.result.error!, /SCREENSHOT_LIMIT/);
  assert.equal(output.calls.filter(name => name === "take_screenshot").length, 3);
  assert.equal(output.requests.length, 7);
});

test("text-model explicit screenshot requests fail before capture even when it guesses a hidden tool", async () => {
  const output = await run(() => answer([{ name: "take_screenshot" }]), async () => ok(tree(1, false)), { model: { ...model, vision: false } });
  assert.match(output.result.error!, /VISION_REQUIRED/);
  assert.deepEqual(output.calls, ["get_ui_tree"]);
});

test("new native observations remove old image evidence and a persistent unavailable episode cannot capture again", async () => {
  for (const recovers of [false, true]) {
    let reads = 0;
    const output = await run((body, index) => {
      if (index === 0) return answer([{ name: "get_ui_tree" }]);
      assert.ok(body.messages.every((message: Json) => !Array.isArray(message.content)), "old screenshot must not be resent after a new tree");
      return answer();
    }, async name => ok(name === "take_screenshot" ? imageResult() : tree(++reads, !(recovers && reads > 2))));
    assert.equal(output.calls.filter(name => name === "take_screenshot").length, 1);
    assert.equal(output.result.status, recovers ? "completed" : "failed");
    if (!recovers) assert.match(output.result.error!, /SCREENSHOT_LIMIT/);
  }
});

test("metadata reads retain one image only while the observed window still matches", async () => {
  for (const changed of [false, true]) {
    const output = await run((_body, index) => index === 0 ? answer([{ name: "get_current_app" }]) : answer(), async name =>
      ok(name === "take_screenshot" ? imageResult() : name === "get_current_app" ? { packageName: snapshot.packageName, windowId: changed ? 999 : snapshot.windowId } : tree()));
    assert.equal(output.result.status, changed ? "failed" : "completed");
    assert.equal(output.requests[1]?.messages.filter((message: Json) => Array.isArray(message.content)).length, changed ? 0 : 1);
  }
});

test("protected, locked, stopped and failed observation reads never enter screenshot fallback", async () => {
  for (const code of ["PROTECTED_APP", "DEVICE_LOCKED", "EMERGENCY_STOPPED", "SERVICE_UNAVAILABLE", "BRIDGE_TIMEOUT", "SENSITIVE_FIELD"]) {
    const output = await run(() => answer(), async () => ({ ok: false, error: { code, message: "Synthetic refusal" } }));
    assert.equal(output.result.status, "failed", code);
    assert.ok(!output.calls.includes("take_screenshot"), code);
  }
});

test("changed capture context, sensitive capture and malformed images are never sent to a model", async () => {
  for (const scenario of ["window", "protected", "invalid", "dimensions"] as const) {
    const output = await run(() => { throw new Error("Unsafe screenshot must not reach model"); }, async name => {
      if (name !== "take_screenshot") return ok(tree());
      if (scenario === "protected") return { ok: false, error: { code: "PROTECTED_APP", message: pixels.data } };
      return ok({ ...imageResult(), ...(scenario === "window" ? { windowId: 999 } : scenario === "dimensions" ? { width: 64 } : { image: { ...pixels, data: "not_an_image" } }) });
    });
    assert.equal(output.result.status, "failed", scenario);
    assert.equal(output.requests.length, 0, scenario);
    assert.ok(!JSON.stringify(output.result).includes(pixels.data));
  }
});

test("unavailable trees without a stable window scope cannot trigger screenshots", async () => {
  const output = await run(() => { throw new Error("Incomplete scope must not reach model"); }, async () => {
    const { windowId: _window, ...incomplete } = tree(); return ok(incomplete);
  });
  assert.match(output.result.error!, /UI_OBSERVATION_UNAVAILABLE/);
  assert.deepEqual(output.calls, ["get_ui_tree", "wait_for_ui_change"]);
});

test("screenshot answers still undergo final session/window continuity checks", async () => {
  for (const scenario of ["window", "session", "protected"] as const) {
    let reads = 0;
    const output = await run(() => answer(), async name => {
      if (name === "take_screenshot") return ok(imageResult());
      const current = tree(++reads);
      if (reads >= 3) {
        if (scenario === "protected") return { ok: false, error: { code: "PROTECTED_APP", message: "Synthetic protection" } };
        return ok({ ...current, ...(scenario === "window" ? { windowId: 999 } : { snapshotId: "new-session:1" }) });
      }
      return ok(current);
    });
    assert.equal(output.result.status, "failed", scenario);
    assert.match(output.result.error!, /COMPLETION_CONTEXT_CHANGED|TARGET_CHANGED|PROTECTED_APP/);
    assert.equal(output.calls.filter(name => name === "take_screenshot").length, 1);
  }
});

test("vision provider rejection is explicit, does not expose body text, and is never retried", async () => {
  for (const status of [400, 415, 422]) {
    const output = await run(() => new Response("SENSITIVE_ERROR_BODY", { status }));
    assert.match(output.result.error!, /MODEL_VISION_UNSUPPORTED/);
    assert.ok(!JSON.stringify([output.result, output.events, output.diagnostics]).includes("SENSITIVE_ERROR_BODY"));
    assert.equal(output.requests.length, 1);
    assert.equal(output.calls.filter(name => name === "take_screenshot").length, 1);
  }
});

test("one bounded image has a separate payload budget and no internal property or output limit leaks to provider", async () => {
  const image = { ...pixels, data: jpeg(300 * 1024) };
  let requests = 0;
  const messages: Message[] = [{ role: "user", content: "a".repeat(180 * 1024), image }];
  const response = await completion(model, messages, [], new AbortController().signal, async (_url, init) => {
    requests++;
    const payload = JSON.parse(String(init.body));
    assert.ok(Buffer.byteLength(String(init.body)) > 256 * 1024);
    assert.equal(payload.messages[0].image, undefined);
    assert.equal(payload.messages[0].content[1].image_url.url, `data:image/jpeg;base64,${image.data}`);
    assert.equal(payload.max_tokens, undefined); assert.equal(payload.max_completion_tokens, undefined);
    return answer();
  });
  assert.equal(requests, 1); assert.ok(response.requestBytes < 1024 * 1024);
  for (const invalid of [messages.concat(messages), [{ role: "user" as const, content: "x", image: { ...pixels, data: jpeg(385 * 1024) } }]]) {
    await assert.rejects(completion(model, invalid, [], new AbortController().signal, async () => { throw new Error("Must reject before network"); }), /截图|一张/);
  }
  await assert.rejects(completion({ ...model, vision: false }, messages, [], new AbortController().signal), /视觉|图片/);
});

test("conversation retains at most one ephemeral image and clears it on fresh observation", () => {
  const conversation = new Conversation("synthetic policy", "synthetic task");
  conversation.screenshot(metadata, pixels);
  const replacement = { ...pixels, data: jpeg(1, 1) };
  conversation.screenshot(metadata, replacement);
  assert.equal(conversation.messages().filter(message => message.image).length, 1);
  assert.ok(!JSON.stringify(conversation.messages()).includes(pixels.data));
  conversation.assistant({ role: "assistant", content: null, tool_calls: [{ id: "read", type: "function", function: { name: "get_ui_tree", arguments: "{}" } }] });
  conversation.result("read", ok(tree(2, false)));
  assert.equal(conversation.messages().filter(message => message.image).length, 0);
});
