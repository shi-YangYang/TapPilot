import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";

type Json = Record<string, unknown>;
type Call = { name: string; args?: Json };
const read = { name: "get_ui_tree" };
const node = { nodeId: "n1", text: "synthetic-private-marker", clickable: true };
const tree = (id: number, text = node.text) => ({ snapshotId: `s${id}`, revision: id, packageName: "synthetic.fixture", nodes: [{ ...node, text }] });
const observed = (id: number, text?: string) => ({ ok: true, result: tree(id, text) });
const click = (id: number): Call => ({ name: "act_and_observe", args: { action: "click_element", arguments: { snapshotId: `s${id}`, nodeId: "n1" }, waitMs: id * 100 } });

async function scenario(calls: Call[], execute: AgentOptions["execute"], inspect?: (turn: number, body: Json) => void) {
  let turn = 0;
  const events: Json[] = [];
  const result = await runAgent({
    task: "Operate on a synthetic fixture only", tools: clientTools,
    model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" },
    execute, onEvent: event => events.push(event),
    modelFetch: async (_url, init) => {
      inspect?.(turn, JSON.parse(init.body as string));
      const call = calls[turn++];
      return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
        role: "assistant", content: call ? null : "Fixture complete",
        ...(call ? { tool_calls: [{ id: `c${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] } : {}),
      } }], usage: { total_tokens: 100 } }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { result, events };
}

test("progress guard observes a third read before deciding whether it repeated", async () => {
  let dispatches = 0;
  const { result } = await scenario([read, read, read], async () => {
    dispatches++;
    return observed(dispatches, dispatches === 4 ? "new synthetic page" : undefined);
  });
  assert.equal(result.status, "completed");
  assert.equal(dispatches, 4);
});

test("progress guard excludes a failed host read from the model repetition budget", async () => {
  let dispatches = 0;
  const { result } = await scenario([read, read, read], async () => ++dispatches < 4 ?
    { ok: false, error: { code: "NO_ACTIVE_WINDOW" } } : observed(dispatches));
  assert.equal(result.status, "completed");
  assert.equal(dispatches, 4);
});

test("progress guard recognizes changed results of the same partial find query", async () => {
  const find = { name: "find_element", args: { selector: { text: "Fixture" } } };
  let finds = 0;
  const { result } = await scenario([find, find, find], async name => {
    if (name === "get_ui_tree") return observed(1);
    finds++;
    return { ok: true, result: { snapshotId: `find${finds}`, revision: finds, elements: finds === 3 ? [node] : [] } };
  });
  assert.equal(result.status, "completed");
  assert.equal(finds, 3);
});

test("progress guard blocks a third mutation despite new snapshot IDs and wait durations", async () => {
  let actions = 0;
  const { result, events } = await scenario([click(1), click(2), click(3)], async name => {
    if (name === "get_ui_tree") return observed(1);
    actions++;
    return { ok: true, result: { action: { accepted: true }, observation: tree(actions + 1) } };
  });
  assert.equal(actions, 2);
  assert.match(result.error!, /REPEATED_ACTION.*act_and_observe（click_element）/);
  const initial = events.find(event => event.type === "tool_end" && event.turn === 0)!;
  assert.equal("observationChanged" in initial, false);
  assert.equal("action" in initial, false);
  const actionEvents = events.filter(event => event.type === "tool_start" && event.turn !== 0);
  assert.deepEqual(actionEvents.map(event => event.action), ["click_element", "click_element"]);
  const endings = events.filter(event => event.type === "tool_end" && event.turn !== 0);
  assert.ok(endings.every(event => event.observationChanged === false && event.ok === true));
  assert.equal(JSON.stringify(events).includes(node.text), false);
  assert.equal(JSON.stringify(events).includes("synthetic-key"), false);
});

test("progress guard does not let changed partial finds clear mutation history", async () => {
  const find = { name: "find_element", args: { selector: { text: "Fixture" } } };
  let actions = 0;
  let finds = 0;
  const { result, events } = await scenario([click(1), find, click(2), find, click(3)], async name => {
    if (name === "get_ui_tree") return observed(1);
    if (name === "find_element") return { ok: true, result: { snapshotId: `find${++finds}`, elements: finds === 1 ? [] : [node] } };
    actions++;
    return { ok: true, result: { action: { accepted: true }, observation: tree(actions + 1) } };
  });
  assert.equal(actions, 2);
  assert.equal(finds, 2);
  assert.match(result.error!, /REPEATED_ACTION.*click_element/);
  assert.ok(events.filter(event => event.type === "tool_end" && event.toolName === "find_element").every(event => !("observationChanged" in event)));
});

test("progress guard supplies host guidance for accepted unchanged UI and permits a later changed read", async () => {
  let reads = 0;
  let actions = 0;
  const { result, events } = await scenario([click(1), read], async name => {
    if (name === "get_ui_tree") return observed(++reads, reads === 2 ? "animation completed" : undefined);
    actions++;
    return { ok: true, result: { action: { accepted: true }, observation: tree(2) } };
  }, (turn, body) => {
    if (turn !== 1) return;
    const messages = body.messages as Json[];
    const latest = JSON.parse(messages.at(-1)!.content as string);
    assert.equal(latest.hostGuidance.code, "OBSERVATION_UNCHANGED");
    assert.match(latest.hostGuidance.message, /Acceptance does not prove/);
    assert.match(latest.hostGuidance.message, /later fresh observation/);
    assert.match(messages[0]!.content as string, /stop if it also has no effect/);
  });
  assert.equal(result.status, "completed");
  assert.equal(actions, 1);
  assert.equal(reads, 2);
  assert.equal(events.find(event => event.type === "tool_end" && event.turn === 2)!.observationChanged, true);
});

test("progress guard bounds event-only waits even when event revisions and timeout arguments change", async () => {
  const waits = [1, 2, 3].map(id => ({ name: "wait_for_ui_change", args: { sinceRevision: id, timeoutMs: id * 100 } }));
  let dispatched = 0;
  const { result } = await scenario(waits, async name => name === "get_ui_tree" ? observed(1) :
    { ok: true, result: { revision: ++dispatched, changed: true, timedOut: false, matched: false } });
  assert.equal(dispatched, 3);
  assert.match(result.error!, /REPEATED_ACTION.*wait_for_ui_change/);
});

test("progress guard diagnostics retain only allowlisted error codes and action names", async () => {
  for (const [code, expected] of [["NOT_CLICKABLE", "NOT_CLICKABLE"], ["private-error-value", "TOOL_FAILED"]]) {
    let actions = 0;
    const { result, events } = await scenario([click(1), click(2), click(3)], async name => {
      if (name === "get_ui_tree") return observed(1);
      actions++;
      return { ok: false, error: { code, message: "private-error-message" } };
    });
    assert.equal(actions, 2);
    assert.match(result.error!, new RegExp(`最近错误：${expected}`));
    const endings = events.filter(event => event.type === "tool_end" && event.turn !== 0);
    assert.ok(endings.every(event => event.errorCode === expected && event.ok === false && event.action === "click_element"));
    assert.equal(JSON.stringify(events).includes("private-error"), false);
    assert.ok(endings.every(event => !("observationChanged" in event)));
  }
});

test("progress guard reports failed observation diagnostics without replaying an accepted action", async () => {
  let actions = 0;
  const { result, events } = await scenario([click(1)], async name => {
    if (name === "get_ui_tree") return observed(1);
    actions++;
    return { ok: true, result: { action: { accepted: true }, observation: null, observationError: { code: "NO_ACTIVE_WINDOW", message: "private-observation-error" } } };
  }, (turn, body) => {
    if (turn !== 1) return;
    const latest = JSON.parse((body.messages as Json[]).at(-1)!.content as string);
    assert.equal(latest.ok, true);
    assert.equal(latest.result.action.accepted, true);
    assert.equal(latest.result.observationError.code, "NO_ACTIVE_WINDOW");
  });
  assert.equal(actions, 1);
  assert.match(result.error!, /NO_OBSERVATION/);
  const ending = events.find(event => event.type === "tool_end" && event.turn === 1)!;
  assert.equal(ending.ok, false);
  assert.equal(ending.action, "click_element");
  assert.equal(ending.errorCode, "NO_ACTIVE_WINDOW");
  assert.equal("observationChanged" in ending, false);
  assert.equal(JSON.stringify(events).includes("private-observation-error"), false);
});
