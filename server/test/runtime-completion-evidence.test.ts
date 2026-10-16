import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { fullObservation } from "../src/runtime/context.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";

type Json = Record<string, any>;
type Call = { name: string; args?: Json };
const tree = (id = 1, overrides: Json = {}): Json => ({ snapshotId: `synthetic-session:${id}`, revision: id,
  packageName: "synthetic.fixture", windowId: 4, truncated: false,
  nodes: [{ nodeId: "n1", text: "Synthetic destination", clickable: true, enabled: true, visible: true }], ...overrides });
const observed = (id = 1, overrides: Json = {}) => ({ ok: true, result: tree(id, overrides) });
const accepted = (id = 2) => ({ ok: true, result: { action: { accepted: true }, observation: tree(id) } });
const tap: Call = { name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: "synthetic-session:1", nodeId: "n1" } } };
const current: Call = { name: "get_current_app" };
const find: Call = { name: "find_element", args: { selector: { text: "Synthetic destination" } } };
const answer = "Synthetic final explanation";

async function scenario(plan: Call[], execute: AgentOptions["execute"]) {
  let turn = 0;
  const calls: string[] = [];
  const requests: Json[] = [];
  const result = await runAgent({ task: "Inspect the synthetic destination", tools: clientTools,
    model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" },
    execute: async (name, args, signal) => { calls.push(name); return execute(name, args, signal); },
    modelFetch: async (_url, init) => {
      requests.push(JSON.parse(init.body as string));
      const call = plan[turn++];
      return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
        role: "assistant", content: call ? null : answer, ...(call ? { tool_calls: [{ id: `c${turn}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] } : {}),
      } }] }));
    },
  });
  return { result, calls, requests };
}

test("a read-only task uses one final host read without another model round", async () => {
  let reads = 0;
  const { result, calls } = await scenario([], async () => observed(++reads));
  assert.equal(result.status, "completed");
  assert.equal(result.answer, answer);
  assert.deepEqual(calls, ["get_ui_tree", "get_ui_tree"]);
  assert.equal(result.metrics.modelRequests, 1);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(result.metrics.completionReads, 1);
});

test("final verification retains sufficient capacity for a complete tree larger than Android defaults", async () => {
  const readArgs: Json[] = [];
  const fullNodes = Array.from({ length: 320 }, (_, index) => ({ nodeId: `n${index}`, text: `Synthetic item ${index}`, visible: true }));
  const expandedRead = { maxNodes: 500, maxDepth: 40 };
  const { result } = await scenario([{ name: "get_ui_tree", args: expandedRead }], async (_name, args) => {
    readArgs.push(args);
    const full = args.maxNodes === 500 && args.maxDepth === 40;
    return observed(readArgs.length, { truncated: !full, nodes: full ? fullNodes : fullNodes.slice(0, 300) });
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(readArgs, [{}, expandedRead, expandedRead]);
  assert.equal(result.metrics.modelRequests, 2);
  assert.equal(result.metrics.completionReads, 1);
});

test("preflight and local refusals retain an explanation but cannot claim completion", async () => {
  for (const local of [false, true]) {
    const { result, calls } = await scenario([tap], async name => name === "get_ui_tree" ? observed() : {
      ok: false, error: { code: local ? "NODE_NOT_ACTIONABLE" : "TARGET_CHANGED" }, observation: tree(),
      meta: local ? { localRejection: true } : { preflightRead: true },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /ACTION_NOT_COMPLETED/);
    assert.equal(result.answer, answer);
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"], "a final read cannot erase an unresolved refusal");
  }
});

test("fresh reads and matching metadata cannot erase a refused action", async () => {
  let reads = 0;
  const { result } = await scenario([tap, { name: "get_ui_tree" }, current], async name => {
    if (name === "get_ui_tree") return observed(++reads);
    if (name === "get_current_app") return { ok: true, result: { packageName: "synthetic.fixture", windowId: 4 } };
    return { ok: false, error: { code: "TARGET_CHANGED" }, observation: tree(2), meta: { preflightRead: true } };
  });
  assert.match(result.error!, /ACTION_NOT_COMPLETED/);
  assert.equal(reads, 2);
});

test("an accepted subsequent action with a full observation recovers an earlier refusal", async () => {
  let actions = 0;
  const { result, calls } = await scenario([tap, { ...tap, args: { action: "press_key", arguments: { key: "home" } } }], async name => {
    if (name === "get_ui_tree") return observed();
    return ++actions === 1 ? { ok: false, error: { code: "TARGET_CHANGED" }, observation: tree(2), meta: { preflightRead: true } } : accepted(3);
  });
  assert.equal(result.status, "completed");
  assert.equal(actions, 2);
  assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", "act_and_observe", "get_ui_tree", "get_ui_tree"]);
  assert.equal(result.metrics.hostReads, 2, "the unchanged accepted action gets a recovery read, followed by the final scope check");
  assert.equal(result.metrics.completionReads, 1);
});

test("partial find matches cannot independently restore completion evidence", async () => {
  const { result, calls } = await scenario([find], async name => name === "get_ui_tree" ? observed() : {
    ok: true, result: { snapshotId: "synthetic-session:2", elements: [{ nodeId: "n1", text: "Synthetic destination" }] },
  });
  assert.match(result.error!, /NO_OBSERVATION/);
  assert.deepEqual(calls, ["get_ui_tree", "find_element"]);
});

test("metadata retains matching evidence and invalidates a changed or failed foreground query", async () => {
  for (const condition of ["matching", "package", "window", "failed"]) {
    const { result, calls, requests } = await scenario([current], async name => name === "get_ui_tree" ? observed() :
      condition === "failed" ? { ok: false, error: { code: "NO_ACTIVE_WINDOW" } } : { ok: true, result: {
        packageName: condition === "package" ? "synthetic.other" : "synthetic.fixture", windowId: condition === "window" ? 9 : 4,
      } });
    assert.equal(result.status, condition === "matching" ? "completed" : "failed", condition);
    assert.equal(calls.length, condition === "matching" ? 3 : 2, condition);
    const currentTrees = requests.at(-1)!.messages.filter((message: Json) => message.role === "tool").map((message: Json) => fullObservation(JSON.parse(message.content))).filter(Boolean);
    assert.equal(currentTrees.length, condition === "matching" ? 1 : 0, "invalidated UI must also leave the model's current context");
    if (condition !== "matching") assert.match(result.error!, /NO_OBSERVATION/);
  }
});

test("final verification detects a session, app or window change while the model answered", async () => {
  for (const overrides of [{ snapshotId: "other-session:2" }, { packageName: "synthetic.other" }, { windowId: 9 }]) {
    let reads = 0;
    const { result, calls } = await scenario([], async () => observed(++reads, reads === 1 ? {} : overrides));
    assert.equal(result.status, "failed");
    assert.match(result.error!, /COMPLETION_CONTEXT_CHANGED/);
    assert.equal(result.answer, answer);
    assert.deepEqual(calls, ["get_ui_tree", "get_ui_tree"]);
    assert.equal(result.metrics.modelRequests, 1);
  }
});

test("final verification checks scope, not identical content or recycled node handles", async () => {
  let reads = 0;
  const { result } = await scenario([], async () => observed(++reads, { nodes: [{ nodeId: `n${reads}`, text: `Synthetic clock ${reads}` }] }));
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.modelRequests, 1);
});

test("a failed final read retains the answer without confirming completion", async () => {
  let reads = 0;
  const { result } = await scenario([], async () => ++reads === 1 ? observed() : { ok: false, error: { code: "NO_ACTIVE_WINDOW" } });
  assert.match(result.error!, /NO_OBSERVATION/);
  assert.equal(result.answer, answer);
  assert.equal(reads, 2);
});

test("protected or terminal final reads stop while preserving the model explanation", async () => {
  for (const code of ["PROTECTED_APP", "DEVICE_LOCKED", "WIRELESS_DISCONNECTED"]) {
    let reads = 0;
    const { result } = await scenario([], async () => ++reads === 1 ? observed() : { ok: false, error: { code } });
    assert.equal(result.status, "failed");
    assert.match(result.error!, new RegExp(code));
    assert.equal(result.answer, answer);
    assert.equal(result.metrics.completionReads, 1);
    assert.equal(reads, 2);
  }
});

test("incomplete observations cannot be upgraded by a final read", async () => {
  for (const overrides of [{ truncated: true }, { nodes: [{ nodeId: "n1", text: "Synthetic hidden content", visible: false }] }]) {
    const { result, calls } = await scenario([], async () => observed(1, overrides));
    assert.match(result.error!, /NO_OBSERVATION/);
    assert.deepEqual(calls, ["get_ui_tree"]);
  }
});

test("only documented observation paths supply a tree", () => {
  const snapshot = tree();
  for (const value of [snapshot, { result: snapshot }, { observation: snapshot }, { result: { observation: snapshot } }]) {
    assert.equal(fullObservation(value), snapshot);
  }
  for (const value of [{ result: { action: { observation: snapshot } } }, { meta: snapshot }, { arbitrary: { nested: snapshot } }]) {
    assert.equal(fullObservation(value), undefined);
  }
});
