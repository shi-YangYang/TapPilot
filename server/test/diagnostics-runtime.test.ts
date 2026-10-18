import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientTools } from "../src/client-tools.js";
import { runAgent, RuntimeError, type ModelFetch } from "../src/runtime/index.js";
import { DiagnosticStore, type DiagnosticEvent } from "../src/diagnostics/index.js";

const SENTINEL = "synthetic-private-SENTINEL-诊断不可保存";
const config = { baseUrl: "http://localhost:9876/v1", apiKey: `${SENTINEL}-key`, model: `${SENTINEL}-model` };
const observation = (revision: number) => ({ snapshotId: `test-session:${revision}`, revision, windowId: 1, packageName: `${SENTINEL}.app`, truncated: false,
  nodes: [{ nodeId: "input", parentId: null, editable: true, enabled: true, text: `${SENTINEL}-ui-${revision}` }] });
const call = { id: "test-call", type: "function", function: { name: "act_and_observe", arguments: JSON.stringify({ action: "input_text", arguments: { snapshotId: "test-session:1", nodeId: "input", text: `${SENTINEL}-input` } }) } };
function model(): ModelFetch {
  let turn = 0;
  return async () => new Response(JSON.stringify({ choices: [{ finish_reason: ++turn === 1 ? "tool_calls" : "stop", message: {
    role: "assistant", content: `${SENTINEL}-model-output`, ...(turn === 1 ? { tool_calls: [call] } : {}),
  } }] }), { headers: { "Content-Type": "application/json" } });
}
async function run(execute: Parameters<typeof runAgent>[0]["execute"], onDiagnostic: NonNullable<Parameters<typeof runAgent>[0]["onDiagnostic"]>, modelFetch = model(), allowBatchedNavigation = false) {
  return runAgent({ allowBatchedNavigation, task: `${SENTINEL}-task`, model: config, modelFetch, tools: clientTools, execute, onDiagnostic, diagnosticVersion: "0.3.19", maxTurns: 2 });
}

test("real runtime persists only whitelisted metadata; successful observations never certify task semantics", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "tappilot-runtime-diagnostics-"));
  const store = new DiagnosticStore({ rootDirectory });
  let acted = false;
  try {
    const result = await run(async (name, args) => {
      if (name === "get_ui_tree") return { ok: true, result: observation(acted ? 2 : 1), meta: { serial: SENTINEL } };
      assert.equal((args.arguments as Record<string, unknown>).text, `${SENTINEL}-input`);
      acted = true;
      return { ok: true, result: { action: { accepted: true, private: SENTINEL }, observation: observation(2) }, meta: { answer: SENTINEL } };
    }, event => { void store.append(event); });
    await store.flush();
    assert.equal(result.status, "completed");
    assert.equal(result.answer, `${SENTINEL}-model-output`);
    const events = await store.list();
    assert.equal(events.filter(item => item.eventType === "model_result").length, 2);
    assert.equal(events.filter(item => item.eventType === "tool_result").length, 3);
    assert.equal(new Set(events.map(item => item.runId)).size, 1);
    assert.deepEqual(events.map(item => item.stepIndex), [0, 1, 2, 3, 4, 5]);
    const action = events.find(item => item.actionKind === "input_text")!;
    assert.equal(action.dispatchState, "sent");
    assert.equal(action.acceptanceState, "accepted");
    assert.equal(action.effectState, "changed");
    assert.equal(events.at(-1)?.runStatus, "completed");
    assert.equal(events.at(-1)?.outcome, "unknown");
    assert.equal(events.at(-1)?.effectState, "unknown");
    const raw = await readFile(join(store.directory, "events.jsonl"), "utf8");
    for (const forbidden of [SENTINEL, "localhost", "9876", "test-session", "apiKey", "answer", "packageName"]) assert.equal(raw.includes(forbidden), false);
  } finally { await store.flush(); await rm(rootDirectory, { recursive: true, force: true }); }
});

test("unknown execution errors and timeouts never become sent, rejected, or ineffective actions", async () => {
  for (const error of [new Error(SENTINEL), new RuntimeError("TOOL_TIMEOUT", SENTINEL)]) {
    const events: DiagnosticEvent[] = [];
    const result = await run(async name => {
      if (name === "get_ui_tree") return { ok: true, result: observation(1) };
      throw error;
    }, event => { events.push(event); });
    assert.equal(result.status, "failed");
    const failure = events.find(item => item.actionKind === "input_text")!;
    assert.equal(failure.outcome, "failure");
    assert.equal(failure.dispatchState, "unknown");
    assert.equal(failure.acceptanceState, "unknown");
    assert.equal(failure.effectState, "unknown");
    assert.equal(JSON.stringify(events).includes(SENTINEL), false);
  }
});

test("only reserved host refusal metadata proves no dispatch; generic preflight-looking responses remain unknown", async () => {
  for (const trusted of [true, false]) {
    const events: DiagnosticEvent[] = [];
    await run(async name => {
      if (name === "get_ui_tree") return { ok: true, result: observation(1) };
      return { ok: false, error: { code: trusted ? "NODE_NOT_ACTIONABLE" : "TARGET_CHANGED", message: SENTINEL, details: { reason: SENTINEL } },
        meta: trusted ? { localRejection: true } : { preflightRead: true }, observation: observation(1) };
    }, event => { events.push(event); });
    const failure = events.find(item => item.actionKind === "input_text")!;
    assert.equal(failure.dispatchState, trusted ? "not_sent" : "unknown");
    assert.equal(failure.failureStage, trusted ? "host_validation" : "unknown");
    assert.equal(failure.reason, "UNKNOWN");
    assert.equal(JSON.stringify(events).includes(SENTINEL), false);
  }
});

test("native context diagnostics require the controller's refusal proof, not an executor string in an observation", async () => {
  const contextChange = { region: "outside_target", kind: "content", changedNodes: 1, targetMatched: true, actionTargetMatched: true };
  for (const trusted of [true, false]) {
    const events: DiagnosticEvent[] = [];
    await run(async name => {
      if (name === "get_ui_tree") return { ok: true, result: observation(1) };
      return { ok: false, error: { code: "TARGET_CHANGED", message: SENTINEL,
        details: { executor: "node-v1", dispatchState: "not_sent", reason: "PAGE_CONTEXT_CHANGED", contextChange } },
        ...(trusted ? { meta: { nativeExecutorRefusal: true } } : {}), observation: { ...observation(2), executor: "node-v1" } };
    }, event => { events.push(event); });
    const failure = events.find(item => item.actionKind === "input_text")!;
    assert.equal(failure.executor, trusted ? "node-v1" : undefined);
    assert.equal(failure.failureStage, trusted ? "phone_validation" : "unknown");
    assert.deepEqual(failure.contextChange, trusted ? contextChange : undefined);
    assert.equal(JSON.stringify(events).includes(SENTINEL), false);
  }
});

test("throwing and rejecting diagnostic readers cannot alter the task or create unhandled rejections", async () => {
  let delivered = 0;
  const result = await run(async name => name === "get_ui_tree" ? { ok: true, result: observation(1) } :
    { ok: true, result: { action: { accepted: true }, observation: observation(2) } }, event => {
      delivered++;
      event.errorCode = "UNKNOWN";
      if (delivered === 1) throw new Error(SENTINEL);
      return Promise.reject(new Error(SENTINEL));
    });
  assert.equal(result.status, "completed");
  assert.ok(delivered >= 5);
  await new Promise(resolve => setImmediate(resolve));
});

test("model connection failures produce a fixed category without persisting model configuration or provider exception text", async () => {
  const events: DiagnosticEvent[] = [];
  const result = await run(async () => ({ ok: true, result: observation(1) }), event => { events.push(event); }, async () => { throw new Error(SENTINEL); });
  assert.equal(result.status, "failed");
  const failure = events.find(item => item.eventType === "model_result")!;
  assert.equal(failure.errorCode, "MODEL_CONNECTION_FAILED");
  assert.equal(failure.failureStage, "model");
  assert.equal(failure.dispatchState, "not_applicable");
  assert.equal(JSON.stringify(events).includes(SENTINEL), false);
});

test("navigation diagnostics retain search outcome independently of accepted dispatch without selectors or candidate handles", async () => {
  for (const stopReason of ["max_steps", "scope_changed", "target_candidate", "target_found"] as const) {
    const events: DiagnosticEvent[] = [];
    let turn = 0;
    const result = await run(async name => name === "get_ui_tree" ? { ok: true, result: observation(1) } : {
      ok: true, result: { action: { accepted: true }, execution: { dispatch: "sent", acceptance: "accepted", effect: "changed", verification: "unverified" },
        navigation: { completedSteps: 3, stopReason, targetFound: stopReason === "target_found",
          ...(stopReason === "target_candidate" ? { candidateNodeIds: [`${SENTINEL}-candidate`] } : {}) }, observation: observation(2) },
    }, event => { events.push(event); }, async () => {
      turn++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: turn === 1 ? "tool_calls" : "stop", message: {
        role: "assistant", content: turn === 1 ? null : "Synthetic navigation inspected", ...(turn === 1 ? { tool_calls: [{
          id: "navigation-call", type: "function", function: { name: "navigate_until", arguments: JSON.stringify({ snapshotId: "test-session:1",
            mode: "swipe", direction: "left", maxSteps: 3, stopWhen: { text: `${SENTINEL}-target` } }) },
        }] } : {}),
      } }] }), { headers: { "Content-Type": "application/json" } });
    }, true);
    assert.equal(result.status, "completed", result.error);
    const navigation = events.find(event => event.actionKind === "navigate_until")!;
    assert.equal(navigation.outcome, "success", "success describes the dispatch, not finding the target");
    assert.equal(navigation.dispatchState, "sent");
    assert.equal(navigation.acceptanceState, "accepted");
    assert.deepEqual(navigation.navigation, { completedSteps: 3, stopReason, targetFound: stopReason === "target_found" });
    const serialized = JSON.stringify(events);
    for (const forbidden of [SENTINEL, "candidateNodeIds", "stopWhen", "test-session"]) assert.equal(serialized.includes(forbidden), false);
  }
});
