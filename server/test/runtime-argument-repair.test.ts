import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";

type Json = Record<string, any>;
const actionArgs = { action: "tap_element", arguments: { snapshotId: "synthetic:1", nodeId: "n1" } };
const call = (id: string, name = "act_and_observe", args: unknown = actionArgs) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const tree = (id: string, text: string) => ({ snapshotId: id, revision: 1, truncated: false, nodes: [
  { nodeId: "n1", text, clickable: true, enabled: true, bounds: [0, 0, 100, 100] },
] });
const results = (body: Json): Json[] => body.messages.filter((message: Json) => message.role === "tool").map((message: Json) => JSON.parse(message.content));

function assertToolPairs(body: Json) {
  const pending = new Set<string>();
  for (const message of body.messages) {
    if (message.role === "tool") assert.ok(pending.delete(message.tool_call_id), `Unexpected tool result ${message.tool_call_id}`);
    else {
      assert.equal(pending.size, 0, "Every call needs a response before the next assistant message");
      for (const item of message.tool_calls ?? []) pending.add(item.id);
    }
  }
  assert.equal(pending.size, 0);
}

async function scenario(plan: (turn: number, body: Json) => { calls?: unknown[]; finish?: string; tokens?: number }, overrides: Partial<AgentOptions> = {}) {
  let turn = 0;
  const dispatched: Array<{ name: string; args: Json }> = [];
  const events: Json[] = [];
  const requests: Json[] = [];
  const result = await runAgent({
    task: "Open the synthetic folder", tools: clientTools,
    model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" },
    execute: async (name, args) => {
      dispatched.push({ name, args });
      return name === "get_ui_tree" ? { ok: true, result: tree("synthetic:1", "Synthetic folder") } : {
        ok: true, result: { action: { accepted: true }, observation: tree("synthetic:2", "Synthetic folder contents") },
      };
    },
    onEvent: event => events.push(event),
    modelFetch: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      assertToolPairs(body);
      requests.push(body);
      const next = plan(turn++, body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: next.finish ?? (next.calls ? "tool_calls" : "stop"), message: {
        role: "assistant", content: next.calls ? null : "Synthetic task complete", ...(next.calls ? { tool_calls: next.calls } : {}),
      } }], usage: { total_tokens: next.tokens ?? 100 } }));
    },
    ...overrides,
  });
  return { result, dispatched, events, requests };
}

test("invalid JSON, non-object and nested schema arguments can be corrected once without an extra read or replay", async () => {
  const invalid = [
    { ...call("invalid"), function: { name: "act_and_observe", arguments: "{ malformed synthetic JSON" } },
    call("invalid", "act_and_observe", []),
    call("invalid", "act_and_observe", { action: "tap_element", arguments: { snapshotId: "synthetic:1", nodeId: 1 } }),
    call("invalid", "act_and_observe", { ...actionArgs, extra: "synthetic-private-argument" }),
  ];
  for (const bad of invalid) {
    const { result, dispatched, events } = await scenario((turn, body) => {
      if (turn === 0) return { calls: [bad] };
      if (turn === 1) {
        const history = results(body);
        assert.equal(history[0]!.result.snapshotId, "synthetic:1", "The rejected batch must preserve the original observation");
        assert.equal(history.at(-1)!.error.code, "INVALID_TOOL_ARGUMENTS");
        assert.equal(history.at(-1)!.accepted, false);
        assert.match(history.at(-1)!.error.message, /entire tool batch was NOT EXECUTED/);
        assert.equal(history.at(-1)!.hostAction, undefined);
        assert.equal(JSON.stringify(history).includes("synthetic-private-argument"), false, "Feedback must not repeat argument values");
        return { calls: [call("corrected")] };
      }
      return {};
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(dispatched, [{ name: "get_ui_tree", args: {} }, { name: "act_and_observe", args: actionArgs }]);
    assert.equal(result.metrics.modelRequests, 3);
    assert.equal(result.metrics.toolCalls, 2, "Argument feedback is not a phone tool invocation");
    assert.equal(result.metrics.hostReads, 0);
    assert.deepEqual(events.filter(event => event.type === "model_correction"), [{ type: "model_correction", turn: 1 }]);
    assert.equal(JSON.stringify(events).includes("synthetic-private-argument"), false);
    assert.equal(JSON.stringify(events).includes("Validator diagnostic"), false);
  }
});

test("a second invalid batch terminates without dispatching and without another correction", async () => {
  for (const afterProgress of [false, true]) {
    const { result, dispatched, events } = await scenario(turn => ({ calls: [afterProgress && turn === 1 ? call("corrected") :
      call(`invalid-${turn}`, "act_and_observe", { ...actionArgs, extra: true })] }));
    assert.equal(result.status, "failed");
    assert.match(result.error!, /INVALID_TOOL_ARGUMENTS/);
    assert.equal(result.metrics.modelRequests, afterProgress ? 3 : 2);
    assert.deepEqual(dispatched.map(item => item.name), afterProgress ? ["get_ui_tree", "act_and_observe"] : ["get_ui_tree"]);
    assert.equal(events.filter(event => event.type === "model_correction").length, 1, "Progress must not reset the per-task correction budget");
  }
});

test("a mixed batch containing a valid action is wholly withheld and every call receives a paired response", async () => {
  const { result, dispatched } = await scenario((turn, body) => {
    if (turn === 0) return { calls: [call("valid-action"), call("invalid-read", "get_current_app", { extra: true })] };
    if (turn === 1) {
      const feedback = results(body).slice(-2);
      assert.deepEqual(feedback.map(item => item.error.code), ["BATCH_NOT_EXECUTED", "INVALID_TOOL_ARGUMENTS"]);
      assert.ok(feedback.every(item => item.accepted === false && /entire tool batch was NOT EXECUTED/.test(item.error.message)));
      return { calls: [call("corrected-action")] };
    }
    return {};
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(dispatched.map(item => item.name), ["get_ui_tree", "act_and_observe"]);
});

test("unknown tools, malformed envelopes, truncated output and multiple actions remain terminal before correction", async () => {
  const bad = call("invalid", "get_current_app", { extra: true });
  const plans = [
    { calls: [bad, call("unknown", "unknown_tool")], error: "UNKNOWN_TOOL" },
    { calls: [{ ...call("broken"), function: { name: "act_and_observe", arguments: actionArgs } }], error: "MODEL_INVALID_TOOL_CALL" },
    { calls: [bad], finish: "length", error: "MODEL_OUTPUT_LIMIT" },
    { calls: [call("action-a", "act_and_observe", {}), call("action-b")], error: "UNOBSERVED_ACTION_BATCH" },
  ];
  for (const next of plans) {
    const { result, dispatched, events } = await scenario(() => next);
    assert.equal(result.status, "failed");
    assert.match(result.error!, new RegExp(next.error));
    assert.deepEqual(dispatched.map(item => item.name), ["get_ui_tree"]);
    assert.equal(result.metrics.modelRequests, 1);
    assert.equal(events.some(event => event.type === "model_correction"), false);
  }
});

test("cancelling at correction feedback prevents the next model request and all actions", async () => {
  const controller = new AbortController();
  const { result, dispatched } = await scenario(() => ({ calls: [call("invalid", "act_and_observe", {})] }), {
    signal: controller.signal,
    onEvent: event => { if (event.type === "model_correction") controller.abort(); },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.metrics.modelRequests, 1);
  assert.deepEqual(dispatched.map(item => item.name), ["get_ui_tree"]);
});

test("argument correction does not extend the turn limit or permit an uncorrected completion claim", async () => {
  const invalid = call("invalid", "act_and_observe", {});
  const limited = await scenario(() => ({ calls: [invalid] }), { maxTurns: 1 });
  assert.match(limited.result.error!, /TURN_LIMIT/);
  assert.equal(limited.result.metrics.modelRequests, 1);
  const uncorrected = await scenario(turn => turn === 0 ? { calls: [invalid] } : {});
  assert.match(uncorrected.result.error!, /INVALID_TOOL_ARGUMENTS/);
  assert.deepEqual(uncorrected.dispatched.map(item => item.name), ["get_ui_tree"]);
});

test("large reported token usage does not stop valid actions or argument correction", async () => {
  const { result, dispatched, events } = await scenario(turn => turn === 0 ? {
    calls: [call("invalid", "act_and_observe", {})], tokens: 120_001,
  } : turn === 1 ? { calls: [call("corrected")], tokens: 250_000 } : { tokens: 500_000 });
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.modelRequests, 3);
  assert.deepEqual(dispatched.map(item => item.name), ["get_ui_tree", "act_and_observe"]);
  assert.equal(events.filter(event => event.type === "model_correction").length, 1);
});

test("a phone-side argument failure after dispatch does not enter the model-format correction path", async () => {
  const dispatched: string[] = [];
  const { result, events } = await scenario(turn => turn === 0 ? { calls: [call("valid-action")] } : {}, {
    execute: async name => {
      dispatched.push(name);
      return name === "get_ui_tree" ? { ok: true, result: tree("synthetic:1", "Synthetic folder") } : { ok: false, error: { code: "INVALID_ARGUMENT" } };
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /NO_OBSERVATION/);
  assert.deepEqual(dispatched, ["get_ui_tree", "act_and_observe"]);
  assert.equal(events.some(event => event.type === "model_correction"), false);
});
