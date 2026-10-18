import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue } from "../src/approvals.js";
import { phoneErrorSchema } from "../src/bridge.js";
import { compactUi, clientTools } from "../src/client-tools.js";
import { windowReadinessSchema } from "../src/observation-contract.js";
import { ToolController } from "../src/tools.js";
import { runAgent } from "../src/runtime/index.js";
import { projectToolResult } from "../src/runtime/ui-projection.js";
import { signature } from "../src/runtime/context.js";
import { snapshot } from "./helpers.js";

type Json = Record<string, any>;
const evidence = (settling = false) => ({ status: settling ? "settling" : "ready",
  reason: settling ? "deadline" : "interaction_stable", samples: 3, waitedMs: 420 });
const tree = (revision = 1, settling = false): Json => ({ ...snapshot, snapshotId: `session:${revision}`, revision,
  observationContract: "semantic-v1", observationCapabilities: { windowReadiness: true }, readiness: evidence(settling),
  quality: { status: "usable", reason: "accessible_content", readableCount: 1, actionableCount: 1 } });
const ok = (result: Json) => ({ ok: true, result });

test("shared controller and compact model data preserve validated startup evidence", async () => {
  const controller = new ToolController({ close: async () => {}, call: async () => ({ id: "fixture", ok: true, result: tree(), meta: { durationMs: 0 } }) },
    new Adb(), new ApprovalQueue(), "trusted");
  try {
    const result = (await controller.invoke("get_ui_tree", {})).structuredContent as Json;
    assert.equal(result.ok, true);
    assert.deepEqual((compactUi(result.result) as Json).readiness, evidence());
    const projected = projectToolResult(result) as Json;
    assert.deepEqual(projected.result.readiness, evidence());
    assert.deepEqual(projected.result.observationCapabilities, { windowReadiness: true });
    assert.equal(signature(tree()), signature({ ...tree(), readiness: evidence(true) }), "readiness is not semantic task progress");
  } finally { await controller.close(); }
});

test("missing or contradictory advertised readiness is rejected", async () => {
  assert.equal(windowReadinessSchema.safeParse({ ...evidence(), reason: "deadline" }).success, false);
  assert.equal(windowReadinessSchema.safeParse({ ...evidence(), samples: -1 }).success, false);
  for (const readiness of [undefined, { ...evidence(), status: "settling" }]) {
    const controller = new ToolController({ close: async () => {}, call: async () => ({ id: "fixture", ok: true,
      result: { ...tree(), readiness }, meta: { durationMs: 0 } }) }, new Adb(), new ApprovalQueue(), "trusted");
    try {
      const result = (await controller.invoke("get_ui_tree", {})).structuredContent as Json;
      assert.equal(result.error.code, "BRIDGE_PROTOCOL_ERROR");
    } finally { await controller.close(); }
  }
});

test("phone startup refusal preserves non-dispatch evidence and its fresh observation", async () => {
  const error = { code: "UI_NOT_READY", message: "Window is still settling", retryable: true,
    details: { executor: "node-v1", dispatchState: "not_sent", reason: "OBSERVATION_SETTLING" } };
  assert.equal(phoneErrorSchema.safeParse(error).success, true);
  const controller = new ToolController({ close: async () => {}, call: async method => method === "get_ui_tree"
    ? { id: "fixture", ok: true, result: tree(1, true), meta: { durationMs: 0 } }
    : { id: "fixture", ok: false, error, observation: tree(2, true), meta: { durationMs: 0 } } },
  new Adb(), new ApprovalQueue(), "trusted");
  try {
    await controller.invoke("get_ui_tree", {});
    const result = (await controller.invoke("act_and_observe", { action: "tap_element", arguments: { snapshotId: "session:1", nodeId: "n0" } })).structuredContent as Json;
    assert.equal(result.ok, false);
    assert.equal(result.meta.nativeExecutorRefusal, true);
    assert.equal(result.observation.snapshotId, "session:2");
    assert.deepEqual((projectToolResult(result) as Json).error.details, { reason: "OBSERVATION_SETTLING" });
  } finally { await controller.close(); }
});

async function run(execute: (name: string, args: Json) => Promise<Json>, act = false, onModelRequest?: () => void) {
  let requests = 0;
  const result = await runAgent({ task: "Read the synthetic app", model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic", model: "fixture" },
    tools: clientTools, execute, modelFetch: async () => {
      onModelRequest?.();
      const first = requests++ === 0;
      return new Response(JSON.stringify({ choices: [{ finish_reason: act && first ? "tool_calls" : "stop", message: act && first ? {
        role: "assistant", content: null, tool_calls: [{ id: "action", type: "function", function: { name: "act_and_observe",
          arguments: JSON.stringify({ action: "tap_element", arguments: { snapshotId: "session:1", nodeId: "n0" } }) } }],
      } : { role: "assistant", content: "Synthetic complete" } }] }), { headers: { "Content-Type": "application/json" } });
    } });
  return { result, requests };
}

test("startup recovery occurs once before the model sees a ready observation", async () => {
  const calls: string[] = [];
  const { result, requests } = await run(async name => {
    calls.push(name); return ok(tree(calls.length, calls.length === 1));
  });
  assert.equal(result.status, "completed");
  assert.equal(requests, 1);
  assert.deepEqual(calls, ["get_ui_tree", "get_ui_tree", "get_ui_tree"], "two startup reads and the existing final continuity read");
});

test("continuously changing accessible window stops before model or screenshot instead of looping", async () => {
  const calls: string[] = [];
  const { result, requests } = await run(async name => { calls.push(name); return ok(tree(calls.length, true)); });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /UI_NOT_READY/);
  assert.equal(requests, 0);
  assert.deepEqual(calls, ["get_ui_tree", "get_ui_tree"]);
});

test("accepted navigation into an unsettled window receives a read, never an action replay", async () => {
  const calls: string[] = [];
  const { result, requests } = await run(async name => {
    calls.push(name);
    if (name === "act_and_observe") return ok({ action: { accepted: true },
      execution: { dispatch: "sent", acceptance: "accepted", effect: "changed", verification: "unverified" },
      observation: { ...tree(2, true), windowId: 4 } });
    return ok({ ...tree(calls.length), windowId: calls.length === 1 ? snapshot.windowId : 4 });
  }, true);
  assert.equal(result.status, "completed");
  assert.equal(requests, 2);
  assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", "get_ui_tree", "get_ui_tree"]);
});

test("native startup refusal with an empty tree recovers before the next model request without replay", async () => {
  const events: string[] = [];
  let reads = 0;
  const { result, requests } = await run(async name => {
    events.push(name);
    if (name === "act_and_observe") return { ok: false,
      error: { code: "UI_NOT_READY", details: { executor: "node-v1", dispatchState: "not_sent", reason: "OBSERVATION_SETTLING" } },
      meta: { nativeExecutorRefusal: true }, observation: { ...tree(2, true), nodes: [],
        quality: { status: "unavailable", reason: "no_accessible_content", readableCount: 0, actionableCount: 0 } } };
    return ok(tree(++reads === 1 ? 1 : 3));
  }, true, () => events.push("model"));
  assert.equal(requests, 2);
  assert.deepEqual(events, ["get_ui_tree", "model", "act_and_observe", "get_ui_tree", "model"]);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /ACTION_NOT_COMPLETED/, "a ready recovery tree must not claim the refused action succeeded");
});
