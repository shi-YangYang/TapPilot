import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import type { DiagnosticEvent } from "../src/diagnostics/schema.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";

type Json = Record<string, any>;
type Call = { name: string; args?: Json };
const tree = (id: number, text = "Synthetic page", windowId = 4) => ({
  snapshotId: `synthetic:s${id}`, windowId, revision: id, truncated: false, packageName: "synthetic.fixture",
  nodes: [
    { nodeId: `root-${id}`, bounds: [0, 0, 400, 800], enabled: true, visible: true },
    { nodeId: `target-${id}`, parentId: `root-${id}`, text, bounds: [20, 20, 100, 80], clickable: true, enabled: true, visible: true },
  ],
});
const tap = (id: number): Call => ({ name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: `synthetic:s${id}`, nodeId: `target-${id}` } } });
const accepted = (id: number, text?: string, windowId?: number) => ({ ok: true, result: { action: { accepted: true }, observation: tree(id, text, windowId) } });
const contextChange = { region: "outside_target", kind: "content", changedNodes: 1, targetMatched: true, actionTargetMatched: true };
const refused = (id: number, text?: string, trusted = true) => ({
  ok: false, error: { code: "TARGET_CHANGED", details: { reason: "PAGE_CONTEXT_CHANGED", contextChange } },
  observation: tree(id, text), meta: { preflightRead: true, ...(trusted ? { hostPreflightRefusal: true } : {}) },
});

async function scenario(plan: Call[], execute: AgentOptions["execute"], inspect?: (turn: number, body: Json) => void) {
  let turn = 0;
  const diagnostics: DiagnosticEvent[] = [];
  const result = await runAgent({
    task: "Navigate synthetic screens", tools: clientTools,
    model: { baseUrl: "https://model.invalid/v1", apiKey: "fixture", model: "fixture" }, execute,
    onDiagnostic: event => { diagnostics.push(event); },
    modelFetch: async (_url, init) => {
      inspect?.(turn, JSON.parse(init.body as string));
      const call = plan[turn++];
      return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
        role: "assistant", content: call ? null : "Fixture complete",
        ...(call ? { tool_calls: [{ id: `c${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] } : {}),
      } }] }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { result, diagnostics };
}

test("two trusted context refusals stop across metadata, full reads and new target handles", async () => {
  let actions = 0;
  let reads = 0;
  const { result, diagnostics } = await scenario([
    tap(1), { name: "get_device_info" }, { name: "get_ui_tree" }, tap(3), tap(4),
  ], async name => {
    if (name === "get_ui_tree") return { ok: true, result: tree(++reads, `Synthetic refresh ${reads}`) };
    if (name === "get_device_info") return { ok: true, result: { connected: true } };
    return refused(++actions + 10, `Synthetic update ${actions}`);
  }, (turn, body) => {
    if (turn !== 1) return;
    const last = JSON.parse(body.messages.filter((message: Json) => message.role === "tool").at(-1).content);
    assert.equal(last.hostGuidance.code, "PAGE_CONTEXT_CHANGED");
    assert.match(last.hostGuidance.message, /no action was sent/);
  });
  assert.match(result.error!, /^PAGE_CONTEXT_UNSTABLE:/);
  assert.equal(actions, 2);
  assert.equal(result.metrics.modelRequests, 4, "the model never gets another decision after the second refusal");
  const refusals = diagnostics.filter(event => event.reason === "PAGE_CONTEXT_CHANGED");
  assert.deepEqual(refusals.map(event => event.contextConflictCount), [1, 2]);
  assert.ok(refusals.every(event => event.dispatchState === "not_sent" && event.failureStage === "host_validation"));
  assert.deepEqual(refusals[0].contextChange, contextChange);
  assert.equal(diagnostics.at(-1)?.errorCode, "PAGE_CONTEXT_UNSTABLE");
});

test("an accepted action without observed progress cannot restore the context allowance", async () => {
  let actions = 0;
  const home: Call = { name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } };
  const { result } = await scenario([tap(1), home, tap(3), tap(4)], async name => {
    if (name === "get_ui_tree") return { ok: true, result: tree(100) };
    return ++actions === 2 ? accepted(2) : refused(actions);
  });
  assert.match(result.error!, /^PAGE_CONTEXT_UNSTABLE:/);
  assert.equal(actions, 3);
  assert.equal(result.metrics.modelRequests, 3);
});

test("validated native refusals retain their fresh UI and stop before a third model decision", async () => {
  let actions = 0;
  let reads = 0;
  const { result, diagnostics } = await scenario([tap(1), tap(2), tap(3)], async name => {
    if (name === "get_ui_tree") { reads++; return { ok: true, result: tree(1) }; }
    return { ok: false, error: { code: "TARGET_CHANGED", details: { executor: "node-v1", dispatchState: "not_sent", reason: "PAGE_CONTEXT_CHANGED" } },
      observation: tree(++actions + 1), meta: { nativeExecutorRefusal: true } };
  }, (turn, body) => {
    if (turn === 1) assert.ok(JSON.stringify(body).includes("synthetic:s2"));
  });
  assert.match(result.error!, /^PAGE_CONTEXT_UNSTABLE:/);
  assert.equal(actions, 2);
  assert.equal(reads, 1, "native refusal supplies evidence without an extra host read");
  const failures = diagnostics.filter(event => event.reason === "PAGE_CONTEXT_CHANGED");
  assert.deepEqual(failures.map(event => event.contextConflictCount), [1, 2]);
  assert.ok(failures.every(event => event.failureStage === "phone_validation" && event.dispatchState === "not_sent"));
});

test("an old executor stops with an upgrade message before another model request", async () => {
  const { result } = await scenario([tap(1), tap(2)], async name => name === "get_ui_tree" ? { ok: true, result: tree(1) } :
    { ok: false, error: { code: "EXECUTOR_UPGRADE_REQUIRED" } });
  assert.match(result.error!, /^EXECUTOR_UPGRADE_REQUIRED:.*APK/);
  assert.equal(result.metrics.modelRequests, 1);
});

test("an accepted but ineffective navigation plus background refresh cannot reset context failures", async () => {
  let actions = 0;
  const home: Call = { name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } };
  const { result } = await scenario([tap(1), home, tap(3), tap(4)], async name => {
    if (name === "get_ui_tree") return { ok: true, result: tree(100) };
    actions++;
    return actions === 2 ? accepted(2, "Synthetic ticker refreshed") : refused(actions, actions > 2 ? "Synthetic ticker refreshed again" : undefined);
  });
  assert.match(result.error!, /^PAGE_CONTEXT_UNSTABLE:/);
  assert.equal(actions, 3);
  assert.equal(result.metrics.modelRequests, 3);
});

test("an observed window transition allows a later independent context refusal to recover", async () => {
  let actions = 0;
  const { result, diagnostics } = await scenario([tap(1), tap(2), tap(3), tap(4)], async name => {
    if (name === "get_ui_tree") return { ok: true, result: tree(100, actions ? "Synthetic destination two" : undefined, actions ? 6 : 4) };
    actions++;
    if (actions % 2) {
      const failure = refused(actions, actions > 2 ? "Synthetic destination one" : undefined);
      failure.observation.windowId = actions > 2 ? 5 : 4;
      return failure;
    }
    return accepted(actions, actions === 2 ? "Synthetic destination one" : "Synthetic destination two", actions === 2 ? 5 : 6);
  });
  assert.equal(result.status, "completed", result.error);
  assert.equal(actions, 4);
  assert.deepEqual(diagnostics.filter(event => event.reason === "PAGE_CONTEXT_CHANGED").map(event => event.contextConflictCount), [1, 1]);
});

test("only a uniquely identified editable field containing the requested input restores allowance", async () => {
  for (const matching of [true, false]) {
    let actions = 0;
    const inputPage = (id: number, text: string) => {
      const page = tree(id, text);
      Object.assign(page.nodes[1], { resourceId: "synthetic:id/query", className: "android.widget.EditText", editable: true, password: false });
      return page;
    };
    const input: Call = { name: "act_and_observe", args: { action: "input_text", arguments: { snapshotId: "synthetic:s1", nodeId: "target-1", text: "Synthetic query" } } };
    const { result, diagnostics } = await scenario([tap(1), input, tap(3), tap(4)], async name => {
      if (name === "get_ui_tree") return { ok: true, result: actions ? tree(100, "Synthetic destination", 5) : inputPage(1, "") };
      actions++;
      if (actions === 4) return accepted(4, "Synthetic destination", 5);
      if (actions === 2) return { ok: true, result: { action: { accepted: true }, observation: inputPage(2, matching ? "Synthetic query" : "Synthetic incidental update") } };
      const failure = refused(actions);
      failure.observation = inputPage(actions, actions > 2 ? "Synthetic query" : "");
      return failure;
    });
    if (matching) {
      assert.equal(result.status, "completed", result.error);
      assert.deepEqual(diagnostics.filter(event => event.reason === "PAGE_CONTEXT_CHANGED").map(event => event.contextConflictCount), [1, 1]);
    } else {
      assert.match(result.error!, /^PAGE_CONTEXT_UNSTABLE:/);
      assert.equal(actions, 3);
    }
  }
});

test("an untrusted reason and preflightRead flag cannot certify local non-dispatch or context evidence", async () => {
  let actions = 0;
  const { result, diagnostics } = await scenario([tap(1), tap(2), tap(3), tap(4)], async name => {
    if (name === "get_ui_tree") return { ok: true, result: tree(1) };
    return refused(++actions + 1, `Synthetic update ${actions}`, false);
  });
  assert.match(result.error!, /^ACTION_RECOVERY_EXHAUSTED:/);
  assert.equal(actions, 3, "the general refusal bound still applies to untrusted errors");
  const refusals = diagnostics.filter(event => event.reason === "PAGE_CONTEXT_CHANGED");
  assert.ok(refusals.every(event => event.dispatchState === "unknown" && event.contextConflictCount === undefined && event.contextChange === undefined));
});

test("session change remains terminal even when it coincides with a second context refusal", async () => {
  let actions = 0;
  const { result } = await scenario([tap(1), tap(2), tap(3)], async name => {
    if (name === "get_ui_tree") return { ok: true, result: tree(1) };
    const failure = refused(++actions + 1);
    if (actions === 2) failure.observation.snapshotId = "different-session:s3";
    return failure;
  });
  assert.match(result.error!, /^TARGET_CHANGED:.*会话/);
  assert.equal(result.metrics.modelRequests, 2);
});
