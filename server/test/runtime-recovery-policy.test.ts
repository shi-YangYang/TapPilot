import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";

type Json = Record<string, any>;
type Call = { name: string; args?: Json };
const tree = (id: number, text = "Synthetic page") => ({ snapshotId: `synthetic:s${id}`, windowId: 4, revision: id, truncated: false, packageName: "synthetic.fixture", nodes: [
  { nodeId: `root-${id}`, bounds: [0, 0, 400, 800], enabled: true, visible: true },
  { nodeId: `target-${id}`, parentId: `root-${id}`, text, bounds: [20, 20, 100, 80], clickable: true, enabled: true, visible: true },
] });
const read = { name: "get_ui_tree" };
const tap = (id: number): Call => ({ name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: `synthetic:s${id}`, nodeId: `target-${id}` } } });
const exit: Call = { name: "act_and_observe", args: { action: "open_settings", arguments: {} } };
const observed = (id: number, text?: string) => ({ ok: true, result: tree(id, text) });
const accepted = (id: number, text?: string) => ({ ok: true, result: { action: { accepted: true }, observation: tree(id, text) } });
const refusal = (id: number) => ({ ok: false, error: { code: "NODE_NOT_ACTIONABLE", details: { reason: "AMBIGUOUS_TOUCH_TARGET" } }, observation: tree(id), meta: { localRejection: true } });
const changedRefusal = (id: number, text?: string) => ({ ok: false, error: { code: "TARGET_CHANGED" }, observation: tree(id, text), meta: { preflightRead: true } });
const results = (body: Json): Json[] => body.messages.filter((entry: Json) => entry.role === "tool").map((entry: Json) => JSON.parse(entry.content));

async function scenario(plan: Call[], execute: AgentOptions["execute"], inspect?: (turn: number, body: Json) => void, tools = clientTools) {
  let turn = 0;
  const dispatched: string[] = [];
  const result = await runAgent({
    task: "Navigate synthetic test screens", tools, model: { baseUrl: "https://model.invalid/v1", apiKey: "fixture", model: "fixture" },
    execute: async (name, args, signal) => { dispatched.push(name); return execute(name, args, signal); },
    modelFetch: async (_url, init) => {
      inspect?.(turn, JSON.parse(init.body as string));
      const call = plan[turn++];
      return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
        role: "assistant", content: call ? null : "Fixture complete",
        ...(call ? { tool_calls: [{ id: `c${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] } : {}),
      } }] }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { result, dispatched };
}

test("initial protection advertises only one explicit settings exit and then restores ordinary actions", async () => {
  let reads = 0;
  const { result, dispatched } = await scenario([exit, tap(2)], async (name, args) => name === "get_ui_tree" ?
    ++reads === 1 ? { ok: false, error: { code: "PROTECTED_APP", message: "Synthetic untrusted protected-page message" } } : observed(4, "Synthetic destination") :
    accepted(args.action === "open_settings" ? 2 : 3, args.action === "open_settings" ? "Synthetic settings" : "Synthetic destination"), (turn, body) => {
      if (turn === 0) {
        assert.equal(body.tools.length, 1);
        assert.equal(body.tools[0].function.name, "act_and_observe");
        assert.deepEqual(body.tools[0].function.parameters.properties.action.enum, ["open_settings"]);
        assert.equal(results(body).at(-1)!.hostGuidance.code, "PROTECTED_SCREEN");
      } else assert.ok(body.tools.some((tool: Json) => tool.function.name === "get_device_info"));
    });
  assert.equal(result.status, "completed");
  assert.deepEqual(dispatched, ["get_ui_tree", "act_and_observe", "act_and_observe", "get_ui_tree"]);
});

test("protected-page metadata queries and Home are rejected before executor dispatch", async () => {
  for (const call of [{ name: "get_current_app" }, { name: "get_device_info" }, { name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } }]) {
    const { result, dispatched } = await scenario([call], async () => ({ ok: false, error: { code: "PROTECTED_APP" } }));
    assert.match(result.error!, /PROTECTED_APP/);
    assert.equal(result.metrics.modelRequests, 1);
    assert.deepEqual(dispatched, ["get_ui_tree"]);
  }
});

test("protection without a supported exit stops before calling the model", async () => {
  const { result, dispatched } = await scenario([], async () => ({ ok: false, error: { code: "PROTECTED_APP" } }), undefined, clientTools.filter(tool => tool.name !== "act_and_observe"));
  assert.match(result.error!, /PROTECTED_APP/);
  assert.equal(result.metrics.modelRequests, 0);
  assert.deepEqual(dispatched, ["get_ui_tree"]);
});

test("a protected safe exit is attempted once, without falling back to another action", async () => {
  const { result, dispatched } = await scenario([exit, exit], async () => ({ ok: false, error: { code: "PROTECTED_APP" } }));
  assert.match(result.error!, /PROTECTED_APP/);
  assert.equal(result.metrics.modelRequests, 1);
  assert.deepEqual(dispatched, ["get_ui_tree", "act_and_observe"]);
});

test("protection reached during an action or its observation stops without another model decision", async () => {
  for (const afterAccepted of [false, true]) {
    const { result, dispatched } = await scenario([tap(1), exit], async name => name === "get_ui_tree" ? observed(1) : afterAccepted ?
      { ok: true, result: { action: { accepted: true }, observation: null, observationError: { code: "PROTECTED_APP" } } } :
      { ok: false, error: { code: "PROTECTED_APP" } });
    assert.match(result.error!, /PROTECTED_APP/);
    assert.equal(result.metrics.modelRequests, 1);
    assert.deepEqual(dispatched, ["get_ui_tree", "act_and_observe"]);
  }
});

test("three distinct rejected targets stop despite metadata, new handles and intervening full reads", async () => {
  let reads = 0;
  const { result, dispatched } = await scenario([tap(1), { name: "get_device_info" }, read, tap(2), { name: "get_current_app" }, read, tap(3)], async (name, args) => {
    if (name === "get_ui_tree") return observed(++reads);
    if (name !== "act_and_observe") return { ok: true, result: { packageName: "synthetic.fixture", revision: reads + 100 } };
    return refusal(Number(String(args.arguments.snapshotId).replace(/^.*:s/, "")));
  }, (turn, body) => {
    if (turn === 1) {
      assert.equal(results(body).at(-1)!.hostGuidance.code, "PRE_DISPATCH_REFUSAL");
      assert.match(results(body).at(-1)!.hostGuidance.message, /2 further consecutive/);
    }
    if (turn === 4) assert.match(results(body).at(-1)!.hostGuidance.message, /1 further consecutive/);
  });
  assert.match(result.error!, /ACTION_RECOVERY_EXHAUSTED.*NODE_NOT_ACTIONABLE/);
  assert.equal(result.metrics.modelRequests, 7);
  assert.equal(dispatched.filter(name => name === "act_and_observe").length, 3);
});

test("fresh changed observations attached to refused actions cannot reset the cross-target budget", async () => {
  let actions = 0;
  const { result } = await scenario([tap(1), tap(2), tap(3), tap(4)], async name => name === "get_ui_tree" ? observed(1) : {
    ok: false, error: { code: "TARGET_CHANGED" }, observation: tree(++actions + 1, `Synthetic changing content ${actions}`), meta: { preflightRead: true },
  });
  assert.match(result.error!, /ACTION_RECOVERY_EXHAUSTED.*TARGET_CHANGED/);
  assert.equal(actions, 3);
  assert.equal(result.metrics.modelRequests, 3);
});

test("phone-side refusals stop after three attempts despite changing handles and refreshed page content", async () => {
  for (const code of ["STALE_SNAPSHOT", "NO_KNOWN_SNAPSHOT", "READ_REQUIRED", "TARGET_CHANGED", "NODE_NOT_ACTIONABLE"]) {
    let reads = 0;
    let actions = 0;
    const { result } = await scenario([tap(1), tap(2), tap(3), tap(4)], async name => {
      if (name === "get_ui_tree") return observed(++reads, `Synthetic live content ${reads}`);
      actions++;
      return { ok: false, error: { code } };
    }, (turn, body) => {
      if (turn === 0) return;
      const guidance = results(body).findLast(item => item.hostGuidance)?.hostGuidance;
      assert.equal(guidance?.code, "PRE_DISPATCH_REFUSAL");
      assert.match(guidance.message, new RegExp(`${3 - turn} further consecutive action refusals`));
    });
    assert.match(result.error!, new RegExp(`ACTION_RECOVERY_EXHAUSTED.*${code}`));
    assert.equal(actions, 3, "each model action is dispatched at most once; the fourth is never requested");
    assert.equal(result.metrics.modelRequests, 3);
    assert.equal(reads, ["STALE_SNAPSHOT", "NO_KNOWN_SNAPSHOT", "READ_REQUIRED"].includes(code) ? 3 : 1,
      "only the first two refreshable refusals schedule a read");
  }
});

test("phone and desktop refusals share one allowance that metadata and reads cannot replenish", async () => {
  let reads = 0;
  let actions = 0;
  const { result } = await scenario([tap(1), { name: "get_device_info" }, tap(2), read, tap(3)], async name => {
    if (name === "get_ui_tree") return observed(++reads, `Synthetic dynamic page ${reads}`);
    if (name === "get_device_info") return { ok: true, result: { connected: true } };
    actions++;
    return actions === 2 ? changedRefusal(10, "Synthetic updated target") : { ok: false, error: { code: "STALE_SNAPSHOT" } };
  });
  assert.match(result.error!, /ACTION_RECOVERY_EXHAUSTED.*STALE_SNAPSHOT/);
  assert.equal(actions, 3);
  assert.equal(reads, 3);
  assert.equal(result.metrics.modelRequests, 5);
});

test("accepted actions with later confirmed progress replenish phone-side refusal allowance", async () => {
  let reads = 0;
  let actions = 0;
  const { result } = await scenario([tap(1), tap(2), tap(3), tap(4), tap(5), tap(6)], async name => {
    if (name === "get_ui_tree") return observed(++reads, `Synthetic observed page ${reads}`);
    actions++;
    return actions % 3 === 0 ? accepted(actions + 100, `Synthetic destination ${actions}`) : { ok: false, error: { code: "STALE_SNAPSHOT" } };
  });
  assert.equal(result.status, "completed");
  assert.equal(actions, 6);
  assert.equal(result.metrics.hostReads, 5, "four refusal recovery reads and one completion read");
});

test("stale observation errors after accepted actions are refreshed without counting as rejected actions", async () => {
  let reads = 0;
  let actions = 0;
  const { result } = await scenario([tap(1), tap(2), tap(3)], async name => {
    if (name === "get_ui_tree") return observed(++reads, `Synthetic loaded page ${reads}`);
    actions++;
    return { ok: true, result: { action: { accepted: true }, observation: null, observationError: { code: "STALE_SNAPSHOT" } } };
  });
  assert.equal(result.status, "completed");
  assert.equal(actions, 3, "accepted actions must never be replayed by recovery");
  assert.equal(result.metrics.hostReads, 4, "three post-action reads and one completion read");
});

test("accepted but ineffective navigation and refreshed node handles do not replenish refused attempts", async () => {
  let actions = 0;
  let reads = 0;
  const home: Call = { name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } };
  const { result } = await scenario([tap(1), tap(2), home, tap(4)], async name => {
    if (name === "get_ui_tree") return observed(++reads);
    actions++;
    return actions === 3 ? accepted(100) : refusal(actions);
  });
  assert.match(result.error!, /ACTION_RECOVERY_EXHAUSTED/);
  assert.equal(actions, 4);
});

test("accepted action with confirmed semantic progress resets the cross-target refusal budget", async () => {
  let actions = 0;
  const { result } = await scenario([tap(1), tap(2), tap(3), tap(4), tap(5)], async name => {
    if (name === "get_ui_tree") return observed(1);
    actions++;
    return actions === 3 ? accepted(4, "Synthetic second page") : changedRefusal(actions + 1, actions > 3 ? "Synthetic second page" : undefined);
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /ACTION_NOT_COMPLETED/);
  assert.equal(actions, 5);
});

test("a later host read may confirm an accepted action and restore the refusal allowance", async () => {
  let actions = 0;
  let reads = 0;
  const { result } = await scenario([tap(1), tap(2), tap(3), tap(4), tap(5)], async name => {
    if (name === "get_ui_tree") return observed(++reads === 1 ? 1 : 4, reads === 1 ? undefined : "Synthetic loaded destination");
    actions++;
    // Keep the immediate handles unchanged too, so the existing host read is scheduled.
    return actions === 3 ? accepted(3) : changedRefusal(actions + 1, actions > 3 ? "Synthetic loaded destination" : undefined);
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /ACTION_NOT_COMPLETED/);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(actions, 5);
});
