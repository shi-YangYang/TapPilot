import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent } from "../src/runtime/index.js";
import { snapshot } from "./helpers.js";
import { Conversation } from "../src/runtime/context.js";

type Json = Record<string, any>;
const tree = (n = 1) => ({ ...snapshot, snapshotId: `session:${n}`, revision: n, observationContract: "semantic-v1",
  quality: { status: "usable", reason: "accessible_content", actionableCount: 1, readableCount: 1 } });
const nav = { name: "navigate_until", args: { snapshotId: "session:1", mode: "swipe", direction: "left", stopWhen: { text: "Synthetic target" }, maxSteps: 3 } };
const response = (calls?: Json[]) => new Response(JSON.stringify({ choices: [{ finish_reason: calls ? "tool_calls" : "stop", message: {
  role: "assistant", content: calls ? null : "Observed synthetic result", ...(calls ? { tool_calls: calls.map((call, i) => ({
    id: `call-${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
  })) } : {}),
} }] }), { headers: { "Content-Type": "application/json" } });
async function run(navigation: Json, firstCalls = [nav], allowBatchedNavigation = true) {
  const calls: string[] = [], bodies: Json[] = [], events: Json[] = [], diagnostics: Json[] = [];
  const result = await runAgent({ task: "Find the synthetic target", tools: clientTools, maxTurns: 3, allowBatchedNavigation,
    model: { baseUrl: "https://synthetic.invalid/v1", apiKey: "", model: "fixture" },
    execute: async name => {
      calls.push(name);
      if (name !== "navigate_until") return { ok: true, result: tree(calls.length) };
      return { ok: true, result: { action: { action: "navigate_until", accepted: navigation.completedSteps > 0,
        dispatchState: navigation.completedSteps > 0 ? "sent" : "not_sent" },
        ...(navigation.completedSteps > 0 ? { execution: { dispatch: "sent", acceptance: "accepted", effect: "changed", verification: "unverified" } } : {}),
        navigation, observation: navigation.uncertainStep ? null : tree(3) } };
    },
    modelFetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return response(bodies.length === 1 ? firstCalls : undefined); },
    onEvent: event => { events.push(event); }, onDiagnostic: event => { diagnostics.push(event); },
  });
  return { result, calls, bodies, events, diagnostics };
}

test("ordinary tasks expose current app instances and single actions without batch navigation or a search allowance", async () => {
  const calls: Json[] = [], bodies: Json[] = [];
  let acted = false;
  const current = () => acted ? { ...tree(2), packageName: "synthetic.chat", nodes: [{ ...snapshot.nodes[0], text: "Synthetic conversations" }] }
    : { ...tree(1), packageName: "synthetic.launcher", nodes: [
      { ...snapshot.nodes[0], nodeId: "chat-first", text: "Synthetic Chat", contentDescription: "Synthetic Chat", bounds: [0, 50, 100, 150] },
      { ...snapshot.nodes[0], nodeId: "chat-second", text: "Synthetic Chat", contentDescription: "Synthetic Chat, cloned instance", bounds: [150, 50, 250, 150] },
    ] };
  const out = await runAgent({ task: "Open the second Synthetic Chat app already on this page", tools: clientTools, maxTurns: 3,
    model: { baseUrl: "https://synthetic.invalid/v1", apiKey: "", model: "fixture" },
    execute: async (name, args) => {
      calls.push({ name, args });
      if (name === "get_ui_tree") return { ok: true, result: current() };
      assert.equal(name, "act_and_observe");
      assert.equal(args.action, "tap_element");
      assert.equal((args.arguments as Json).nodeId, "chat-second");
      acted = true;
      return { ok: true, result: { action: { accepted: true }, execution: { dispatch: "sent", acceptance: "accepted", effect: "changed", verification: "unverified" }, observation: current() } };
    },
    modelFetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      assert.equal(body.tools.some((tool: Json) => tool.function.name === "navigate_until"), false);
      assert.doesNotMatch(body.messages[0].content, /navigate_until|remainingSteps/);
      assert.match(body.messages[0].content, /Ordinals such as "second"/);
      const actions = body.tools.find((tool: Json) => tool.function.name === "act_and_observe").function.parameters.properties.action.enum;
      for (const action of ["tap_element", "swipe", "scroll", "press_key"]) assert.ok(actions.includes(action));
      if (acted) return response();
      const observed = JSON.parse(body.messages.findLast((message: Json) => message.role === "tool").content).result;
      const clone = observed.nodes.find((node: Json) => node.desc?.includes("cloned instance"));
      assert.equal(clone.nodeId, "chat-second");
      return response([{ name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: observed.snapshotId, nodeId: clone.nodeId } } }]);
    },
  });
  assert.equal(out.status, "completed", out.error);
  assert.deepEqual(calls.map(call => call.name), ["get_ui_tree", "act_and_observe", "get_ui_tree"]);
  assert.equal(bodies.length, 2);
});

test("ordinary tasks reject a hidden batch-navigation request before dispatch", async () => {
  const out = await run({ completedSteps: 1, stopReason: "max_steps", targetFound: false }, [nav], false);
  assert.match(out.result.error!, /UNKNOWN_TOOL/);
  assert.deepEqual(out.calls, ["get_ui_tree"]);
});

test("one model call can request bounded navigation and inspect the final UI and step count", async () => {
  const navigation = { completedSteps: 2, stopReason: "target_found", targetFound: true };
  const out = await run(navigation);
  assert.equal(out.result.status, "completed", out.result.error);
  assert.deepEqual(out.calls, ["get_ui_tree", "navigate_until", "get_ui_tree"]);
  assert.equal(out.bodies.length, 2);
  assert.ok(out.bodies[0]!.tools.some((tool: Json) => tool.function.name === "navigate_until"));
  const tool = out.bodies[1]!.messages.findLast((message: Json) => message.role === "tool");
  assert.deepEqual(JSON.parse(tool.content).result.navigation, navigation);
  const event = out.events.find(event => event.type === "tool_end" && event.toolName === "navigate_until");
  assert.equal(event?.navigationSteps, 2); assert.equal(event?.navigationStopReason, "target_found");
  assert.ok(out.diagnostics.some(event => event.actionKind === "navigate_until"));
});

test("already-present target takes zero steps without inventing a failed action", async () => {
  const out = await run({ completedSteps: 0, stopReason: "target_found", targetFound: true });
  assert.equal(out.result.status, "completed", out.result.error);
});

test("reaching the step bound is reported to the model without inventing a found target", async () => {
  const out = await run({ completedSteps: 3, stopReason: "max_steps", targetFound: false });
  const tool = out.bodies[1]!.messages.findLast((message: Json) => message.role === "tool");
  assert.equal(JSON.parse(tool.content).result.navigation.targetFound, false);
  assert.equal(out.calls.filter(name => name === "navigate_until").length, 1);
});

test("partial failure preserves step evidence and stops without another decision or replay", async () => {
  const out = await run({ completedSteps: 1, stopReason: "action_failed", targetFound: false, uncertainStep: true,
    error: { code: "BRIDGE_TIMEOUT", message: "Synthetic timeout", retryable: false } });
  assert.equal(out.result.status, "failed"); assert.match(out.result.error!, /BRIDGE_TIMEOUT/);
  assert.deepEqual(out.calls, ["get_ui_tree", "navigate_until"]); assert.equal(out.bodies.length, 1);
  const event = out.events.find(event => event.type === "tool_end" && event.toolName === "navigate_until");
  assert.equal(event?.navigationSteps, 1); assert.equal(event?.ok, false);
});

test("navigation cannot share a model batch with another mutation", async () => {
  const out = await run({ completedSteps: 2, stopReason: "target_found", targetFound: true }, [nav,
    { name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } }]);
  assert.match(out.result.error!, /UNOBSERVED_ACTION_BATCH/);
  assert.deepEqual(out.calls, ["get_ui_tree"]);
});

type SearchCall = { name: string; args: Json; stopReason?: string; candidate?: boolean; unchanged?: boolean };
const search = (steps: number, direction = "left", stopReason = "max_steps"): SearchCall => ({
  name: "navigate_until", args: { mode: "swipe", direction, stopWhen: { text: "Synthetic missing app" }, maxSteps: steps }, stopReason,
});
const key = (key: string): SearchCall => ({ name: "act_and_observe", args: { action: "press_key", arguments: { key } } });
const swipe = (): SearchCall => ({ name: "act_and_observe", args: { action: "swipe", arguments: {
  startX: 250, startY: 500, endX: 50, endY: 500,
} } });
const tap = (unchanged = false): SearchCall => ({ name: "act_and_observe", args: { action: "tap_element", arguments: { nodeId: "n0" } }, unchanged });

async function searchSequence(sequence: SearchCall[]) {
  let revision = 1, page = 0, modelTurn = 0, latestCall: SearchCall | undefined;
  const calls: Json[] = [], bodies: Json[] = [];
  const observation = () => ({ ...tree(revision), nodes: snapshot.nodes.map(node => ({ ...node,
    text: `Synthetic current page ${page}`, nodeId: `n${revision}` })) });
  const result = await runAgent({ task: "Find a synthetic missing app", tools: clientTools, maxTurns: 24, allowBatchedNavigation: true,
    model: { baseUrl: "https://synthetic.invalid/v1", apiKey: "", model: "fixture" },
    execute: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      if (name === "get_ui_tree") return { ok: true, result: observation() };
      const call = latestCall!;
      revision++;
      if (!call.unchanged) page++;
      const navigation = name === "navigate_until" ? { completedSteps: args.maxSteps,
        stopReason: call.stopReason, targetFound: call.stopReason === "target_found",
        ...(call.stopReason === "target_candidate" ? { candidateNodeIds: [`n${revision}`] } : {}) } : undefined;
      return { ok: true, result: { action: { action: name === "act_and_observe" ? args.action : name, accepted: true,
        dispatchState: "sent", completion: "completed" }, execution: { dispatch: "sent", acceptance: "accepted",
        effect: call.unchanged ? "unchanged" : "changed", verification: "unverified" },
        ...(navigation ? { navigation } : {}), observation: observation() } };
    },
    modelFetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      const call = sequence[modelTurn++]; latestCall = call;
      if (!call) return response();
      const args = structuredClone(call.args);
      if (call.name === "navigate_until") args.snapshotId = `session:${revision}`;
      if (call.name === "act_and_observe" && args.action !== "press_key") {
        args.arguments.snapshotId = `session:${revision}`;
        if (args.arguments.nodeId) args.arguments.nodeId = `n${revision}`;
      }
      return response([{ name: call.name, args }]);
    },
  });
  return { result, calls, bodies };
}

test("search allowance survives Home/Back, changed directions and new page/node handles", async () => {
  const out = await searchSequence([search(3), key("home"), search(3, "right", "scope_changed"),
    key("back"), search(2), swipe()]);
  assert.match(out.result.error!, /NAVIGATION_EXHAUSTED/);
  const navigation = out.calls.filter(call => call.name === "navigate_until");
  assert.equal(navigation.length, 3);
  assert.equal(navigation.reduce((total, call) => total + call.args.maxSteps, 0), 8);
  assert.equal(out.calls.some(call => call.args.action === "swipe"), false);
  const last = out.bodies.at(-1)!;
  assert.equal(last.tools.some((tool: Json) => tool.function.name === "navigate_until"), false);
  const actions = last.tools.find((tool: Json) => tool.function.name === "act_and_observe").function.parameters.properties.action.enum;
  for (const hidden of ["swipe", "scroll", "swipe_visual", "press_key", "open_settings"]) assert.equal(actions.includes(hidden), false);
  assert.ok(actions.includes("tap_element"));
  assert.match(last.messages[0].content, /"completedSteps":8,"remainingSteps":0/);
});

test("a valid navigation upper bound uses the remaining allowance and explicitly reports both limits", async () => {
  const out = await searchSequence([search(3), search(3, "right"), search(3)]);
  assert.equal(out.result.status, "completed", out.result.error);
  assert.deepEqual(out.calls.filter(call => call.name === "navigate_until").map(call => call.args.maxSteps), [3, 3, 2]);
  const offered = (body: Json) => body.tools.find((tool: Json) => tool.function.name === "navigate_until").function.parameters;
  assert.deepEqual(offered(out.bodies[2]!), offered(out.bodies[0]!), "remaining allowance does not rewrite the tool schema");
  assert.equal(offered(out.bodies[2]!).properties.maxSteps.maximum, 4);
  const final = out.bodies.at(-1)!;
  const result = JSON.parse(final.messages.findLast((message: Json) => message.role === "tool").content);
  assert.equal(result.result.navigation.completedSteps, 2);
  assert.equal(result.result.navigation.targetFound, false);
  assert.match(result.hostGuidance.message, /requestedMaxSteps=3; effectiveMaxSteps=2/);
  const call = final.messages.findLast((message: Json) => message.role === "assistant" && message.tool_calls);
  assert.equal(JSON.parse(call.tool_calls[0].function.arguments).maxSteps, 3, "original model request is retained truthfully");
  assert.equal(final.tools.some((tool: Json) => tool.function.name === "navigate_until"), false);
  assert.match(final.messages[0].content, /"completedSteps":8,"remainingSteps":0/);
});

test("an invalid maxSteps above the public schema is corrected before any dispatch", async () => {
  const out = await searchSequence([search(5), search(1)]);
  assert.equal(out.result.status, "completed", out.result.error);
  assert.deepEqual(out.calls.filter(call => call.name === "navigate_until").map(call => call.args.maxSteps), [1]);
  assert.match(out.bodies[1]!.messages.findLast((message: Json) => message.role === "tool").content, /INVALID_TOOL_ARGUMENTS/);
});

test("an exhausted search refuses a hidden navigation call without dispatch", async () => {
  const out = await searchSequence([search(3), search(3, "right"), search(3), search(1)]);
  assert.match(out.result.error!, /NAVIGATION_EXHAUSTED/);
  assert.deepEqual(out.calls.filter(call => call.name === "navigate_until").map(call => call.args.maxSteps), [3, 3, 2]);
});

test("standalone swipes consume the same search allowance and hidden Home cannot reset it", async () => {
  const out = await searchSequence([search(3), swipe(), swipe(), search(3, "right"), key("home")]);
  assert.match(out.result.error!, /NAVIGATION_EXHAUSTED/);
  assert.equal(out.calls.filter(call => call.args.action === "swipe").length, 2);
  assert.equal(out.calls.some(call => call.args.action === "press_key"), false);
});

test("found target and related candidates pause batching until a current native target is used", async () => {
  for (const stopReason of ["target_found", "target_candidate"]) {
    const refused = await searchSequence([search(1, "left", stopReason), search(1)]);
    assert.match(refused.result.error!, /NAVIGATION_EXHAUSTED/);
    assert.equal(refused.calls.filter(call => call.name === "navigate_until").length, 1);
    const continued = await searchSequence([search(1, "left", stopReason), tap(), search(1)]);
    assert.equal(continued.result.status, "completed", continued.result.error);
    assert.equal(continued.calls.filter(call => call.name === "navigate_until").length, 2);
  }
});

test("an accepted unchanged tap does not restore exhausted search", async () => {
  const out = await searchSequence([search(4), search(4, "right"), tap(true), search(1)]);
  assert.match(out.result.error!, /NAVIGATION_EXHAUSTED/);
  assert.equal(out.calls.filter(call => call.name === "navigate_until").length, 2);
});

test("a false candidate can be rejected by an observed standalone move without restoring the search allowance", async () => {
  const out = await searchSequence([search(2, "left", "target_candidate"), swipe(), search(3, "left"), search(3)]);
  assert.equal(out.result.status, "completed", out.result.error);
  assert.deepEqual(out.calls.filter(call => call.name === "navigate_until").map(call => call.args.maxSteps), [2, 3, 2], "the candidate can be rejected and the final batch stays within the remaining allowance");
  assert.equal(out.calls.some(call => call.args.action === "tap_element"), false, "rejecting an unrelated candidate never requires clicking it");
  const afterMove = out.bodies[2]!;
  assert.ok(afterMove.tools.some((tool: Json) => tool.function.name === "navigate_until"));
  assert.match(afterMove.messages[0].content, /"completedSteps":3,"remainingSteps":5/);
  assert.match(afterMove.messages[0].content, /"requiresTargetDecision":false/);
  assert.equal(out.bodies.at(-1)!.tools.some((tool: Json) => tool.function.name === "navigate_until"), false);
  const noMovement = await searchSequence([search(2, "left", "target_candidate"), { ...swipe(), unchanged: true }, search(1)]);
  assert.match(noMovement.result.error!, /NAVIGATION_EXHAUSTED/);
  assert.equal(noMovement.calls.filter(call => call.name === "navigate_until").length, 1, "an accepted unchanged move does not clear candidate review");
});

test("navigation facts survive superseded trees and six-round history compaction without retaining candidate handles", () => {
  const conversation = new Conversation("Synthetic system", "Synthetic task");
  conversation.setNavigationProgress({ completedSteps: 3, remainingSteps: 5, stopReason: "target_candidate", targetFound: false, requiresTargetDecision: true });
  conversation.assistant({ role: "assistant", content: null, tool_calls: [{ id: "search", type: "function", function: { name: "navigate_until", arguments: "{}" } }] });
  conversation.result("search", { ok: true, result: { navigation: { completedSteps: 3, stopReason: "target_candidate", targetFound: false,
    candidateNodeIds: ["old-candidate"] }, observation: tree(1) } });
  conversation.assistant({ role: "assistant", content: null, tool_calls: [{ id: "refresh", type: "function", function: { name: "get_ui_tree", arguments: "{}" } }] });
  conversation.result("refresh", { ok: true, result: tree(2) });
  const prior = JSON.parse(conversation.messages().find(message => message.tool_call_id === "search")!.content!);
  assert.match(prior.hostGuidance.message, /stopReason=target_candidate; exactTargetFound=false/);
  assert.equal(JSON.stringify(prior).includes("old-candidate"), false);
  for (let i = 0; i < 8; i++) {
    conversation.assistant({ role: "assistant", content: null, tool_calls: [{ id: `read-${i}`, type: "function", function: { name: "get_ui_tree", arguments: "{}" } }] });
    conversation.result(`read-${i}`, { ok: true, result: tree(i + 3) });
  }
  assert.match(conversation.messages()[0]!.content!, /"completedSteps":3,"remainingSteps":5/);
});
