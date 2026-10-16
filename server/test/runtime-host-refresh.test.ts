import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";

type Json = Record<string, any>;
type Call = { name: string; args?: Json };
const tree = (id: string, text = "Synthetic folder") => ({ snapshotId: id, revision: 1, truncated: false, nodes: [
  { nodeId: "n1", text, bounds: [10, 20, 80, 90], enabled: true, clickable: true },
] });
const observed = (id: string, text?: string) => ({ ok: true, result: tree(id, text) });
const action = (id = "initial"): Call => ({ name: "act_and_observe", args: { action: "click_element", arguments: { snapshotId: id, nodeId: "n1" } } });
const accepted = (id = "immediate", text?: string) => ({ ok: true, result: { action: { accepted: true }, observation: tree(id, text) } });
const toolResults = (body: Json): Json[] => body.messages.filter((message: Json) => message.role === "tool").map((message: Json) => JSON.parse(message.content));

async function scenario(plan: (turn: number, body: Json) => Call[] | undefined, execute: AgentOptions["execute"], signal?: AbortSignal) {
  let turn = 0;
  const events: Json[] = [];
  const requests: Json[] = [];
  const result = await runAgent({
    task: "Open the synthetic folder", tools: clientTools, execute, signal, onEvent: event => events.push(event),
    model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" },
    modelFetch: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      requests.push(body);
      const calls = plan(turn++, body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: calls ? "tool_calls" : "stop", message: {
        role: "assistant", content: calls ? null : "Fixture complete",
        ...(calls ? { tool_calls: calls.map((call, i) => ({ id: `c${turn}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } : {}),
      } }], usage: { total_tokens: 100 } }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { result, events, requests };
}

function assertValidToolPairs(body: Json) {
  const pending = new Set<string>();
  for (const message of body.messages) {
    if (message.role === "tool") {
      assert.ok(pending.delete(message.tool_call_id), `unexpected tool response ${message.tool_call_id}`);
    } else {
      assert.equal(pending.size, 0, "all previous tool responses must precede another message");
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0);
}

test("one host verification removes the model read round before an observed gesture fallback", async () => {
  let reads = 0;
  const actions: string[] = [];
  const { result, requests, events } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    if (turn === 0) return [action()];
    const latest = toolResults(body).at(-1)!;
    if (latest.hostGuidance?.code === "NATIVE_CLICK_INEFFECTIVE") {
      assert.equal(latest.result.snapshotId, "verified");
      return [{ name: "act_and_observe", args: { action: "swipe", arguments: {
        snapshotId: latest.result.snapshotId, startX: 45, startY: 55, endX: 45, endY: 55, durationMs: 80,
      } } }];
    }
    if (latest.hostGuidance?.code === "OBSERVATION_UNCHANGED") return [{ name: "get_ui_tree" }];
    return undefined;
  }, async (name, args) => {
    if (name === "get_ui_tree") return observed(++reads === 1 ? "initial" : "verified");
    actions.push(args.action as string);
    return args.action === "click_element" ? accepted() : accepted("opened", "Synthetic folder contents");
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 3, "click → fallback → finish, without a model round to request verification");
  assert.deepEqual(actions, ["click_element", "swipe"]);
  assert.equal(reads, 2);
  assert.equal(result.metrics.toolCalls, 4);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(events.filter(event => event.type === "tool_end" && event.toolName === "get_ui_tree").length, 2);
});

test("recoverable snapshot errors get one fresh observation without replaying the action", async () => {
  for (const code of ["STALE_SNAPSHOT", "NO_KNOWN_SNAPSHOT", "READ_REQUIRED"]) {
    for (const nested of [false, true]) {
      const calls: string[] = [];
      const { result } = await scenario((turn, body) => {
        if (turn === 0) return [action()];
        assertValidToolPairs(body);
        const history = toolResults(body);
        assert.equal(history.at(-1)!.result.snapshotId, "refreshed");
        assert.ok(JSON.stringify(history).includes(code));
        return undefined;
      }, async name => {
        calls.push(name);
        if (name === "get_ui_tree") return observed(calls.length === 1 ? "initial" : "refreshed", "Synthetic refreshed page");
        return nested ? { ok: true, result: { action: { accepted: true }, observationError: { code } } } : { ok: false, error: { code } };
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", "get_ui_tree"]);
      assert.equal(result.metrics.modelRequests, 2);
      assert.equal(result.metrics.hostReads, 1);
    }
  }
});

test("a changed combined observation does not issue a host refresh", async () => {
  const calls: string[] = [];
  const { result } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => {
    calls.push(name);
    return name === "get_ui_tree" ? observed("initial") : accepted("changed", "New synthetic page");
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
  assert.equal(result.metrics.hostReads, 0);
});

test("an explicit full read later in the same model batch satisfies verification without an extra read", async () => {
  let reads = 0;
  const { result } = await scenario((turn, body) => {
    assertValidToolPairs(body);
    if (turn === 0) return [action(), { name: "get_ui_tree" }];
    assert.equal(toolResults(body).at(-1)!.hostGuidance.code, "NATIVE_CLICK_INEFFECTIVE");
    return undefined;
  }, async name => name === "get_ui_tree" ? observed(++reads === 1 ? "initial" : "explicit") : accepted());
  assert.equal(result.status, "completed");
  assert.equal(reads, 2);
  assert.equal(result.metrics.hostReads, 0);
});

test("restricted or terminal action errors never trigger automatic refresh or mutation replay", async () => {
  for (const code of ["MANUAL_ACTION_REQUIRED", "EMERGENCY_STOPPED", "WIRELESS_TIMEOUT", "PROTECTED_APP", "PASSWORD_FIELD_BLOCKED"]) {
    const calls: string[] = [];
    const { result } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => {
      calls.push(name);
      return name === "get_ui_tree" ? observed("initial") : { ok: false, error: { code } };
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"]);
    assert.equal(result.metrics.hostReads, 0);
  }
});

test("cancellation before or during the host read stops without further model requests", async () => {
  for (const duringRead of [false, true]) {
    const controller = new AbortController();
    let reads = 0;
    const { result, requests } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => {
      if (name === "get_ui_tree") {
        reads++;
        if (reads === 2) { controller.abort(); return new Promise(() => {}); }
        return observed("initial");
      }
      if (!duringRead) controller.abort();
      return accepted();
    }, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(requests.length, 1);
    assert.equal(reads, duringRead ? 2 : 1);
  }
});

test("terminal errors during host refresh stop through the ordinary tool error gate", async () => {
  let reads = 0;
  const { result, requests } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => name === "get_ui_tree" ?
    ++reads === 1 ? observed("initial") : { ok: false, error: { code: "WIRELESS_DISCONNECTED" } } : accepted());
  assert.equal(result.status, "failed");
  assert.match(result.error!, /WIRELESS_DISCONNECTED/);
  assert.equal(requests.length, 1);
  assert.equal(reads, 2);
});

test("empty, partial or disabled-placeholder refresh data cannot certify task completion", async () => {
  for (const observation of [
    { snapshotId: "empty", nodes: [] },
    { snapshotId: "partial", elements: [{ nodeId: "n1", text: "Synthetic match" }] },
    { snapshotId: "placeholder", nodes: [{ nodeId: "n0", className: "android.view.View", bounds: [0, 0, 0, 0], enabled: false }] },
  ]) {
    let reads = 0;
    const { result } = await scenario(turn => turn === 0 ? [action()] : undefined, async name => name === "get_ui_tree" ?
      ++reads === 1 ? observed("initial") : { ok: true, result: observation } : { ok: false, error: { code: "STALE_SNAPSHOT" } });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /NO_OBSERVATION/);
    assert.equal(reads, 2, "a failed verification is not automatically polled again");
  }
});
