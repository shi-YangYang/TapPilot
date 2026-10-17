import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { clientTools } from "../src/client-tools.js";
import { modelScope } from "../src/learning/schema.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";
import { SkillSpecSchema, SKILL_POLICY_REVISION, skillHash, type SkillSpec } from "../src/skills/schema.js";
import { FailureEpisodeSchema, TraceStepSchema, type FailureEpisode, type TraceStep } from "../src/skills/trace.js";
import { SkillSession } from "../src/skills/runtime.js";
import { DiagnosticEventSchema } from "../src/diagnostics/schema.js";

type Json = Record<string, any>;
const model = { baseUrl: "https://runtime-fixture.invalid/v1", apiKey: "fixture-secret-key", model: "runtime-fixture" };
const secret = "PRIVATE-TASK-CHAT-验证码";
const app = "private.fixture.app";
const scope = { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: modelScope(model).modelProfile, appDigest: createHash("sha256").update(app).digest("hex") };
const tree = (revision = 1, changed = false): Json => ({ snapshotId: `private-session:${revision}`, revision, packageName: app, windowId: 1, truncated: false,
  nodes: [
    { nodeId: "private-parent", text: changed ? "Synthetic verified destination" : secret, clickable: true, visible: true, enabled: true },
    { nodeId: "private-child", parentId: "private-parent", text: secret, clickable: false, visible: true, enabled: true },
  ] });
const skill = (): SkillSpec => SkillSpecSchema.parse({ schemaVersion: 1, scope, trigger: { errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET", actionKind: "tap_element" },
  entryConditions: [{ fact: "targetAncestorClickable", test: "eq", value: "yes" }],
  program: { entry: 0, nodes: [
    { kind: "step", operation: { op: "inspect", aspect: "hierarchy" }, next: 1 },
    { kind: "step", operation: { op: "resolve_target", capability: "clickable", maxAncestorHops: 1 }, next: 2 },
    { kind: "step", operation: { op: "activate_resolved_target", target: "current_task_target" }, next: 3 },
    { kind: "step", operation: { op: "verify_effect", evidence: "current_observation" }, next: 4 },
    { kind: "end", outcome: "continue" },
  ] }, lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 100_000 });

async function scenario(snapshot: readonly SkillSpec[], observers: Partial<AgentOptions> = {}) {
  let turn = 0, state = 0;
  const requests: Json[] = [], traces: TraceStep[] = [], episodes: FailureEpisode[] = [], used: readonly string[][] = [];
  const usedMutable: string[][] = used as string[][];
  const result = await runAgent({ task: secret, model, tools: clientTools, diagnosticVersion: "0.3.19", skillSnapshot: snapshot,
    onSkillTrace: trace => { traces.push(trace); }, onFailureEpisode: episode => { episodes.push(episode); }, onSkillUsed: hashes => { usedMutable.push([...hashes]); },
    execute: async name => {
      if (name === "get_ui_tree") return { ok: true, result: tree(state ? 2 : 1, state > 0) };
      if (!state++) return { ok: false, error: { code: "NODE_NOT_ACTIONABLE", details: { reason: "NO_CLICKABLE_TARGET" } }, observation: tree(), meta: { localRejection: true } };
      return { ok: true, result: { action: { accepted: true }, observation: tree(2, true) } };
    },
    modelFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      const current = turn++;
      const call = current < 2 ? { id: `call-${current}`, type: "function", function: { name: "act_and_observe", arguments: JSON.stringify({ action: "tap_element", arguments: { snapshotId: "private-session:1", nodeId: current ? "private-parent" : "private-child" } }) } } : undefined;
      return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: { role: "assistant", content: call ? null : "Synthetic result", ...(call ? { tool_calls: [call] } : {}) } }] }));
    }, ...observers,
  });
  return { result, requests, traces, episodes, used };
}

test("production runtime injects a learned procedure in the next existing decision and emits private evidence", async () => {
  const spec = skill();
  const run = await scenario([spec]);
  assert.equal(run.result.status, "completed");
  assert.equal(run.result.metrics.modelRequests, 3, "procedure retrieval creates no extra model request");
  assert.doesNotMatch(run.requests[0]!.messages[0].content, /Validated procedural hint/);
  assert.match(run.requests[1]!.messages[0].content, /Validated procedural hint/);
  assert.match(run.requests[1]!.messages[0].content, /inspecting at most 1 observed ancestors/);
  assert.doesNotMatch(run.requests[2]!.messages[0].content, /Validated procedural hint/);
  assert.deepEqual(run.used, [[skillHash(spec)]]);
  assert.ok(run.traces.every(trace => TraceStepSchema.safeParse(trace).success));
  assert.equal(run.episodes.length, 1);
  assert.equal(FailureEpisodeSchema.safeParse(run.episodes[0]).success, true);
  assert.equal(run.episodes[0]!.termination, "completed", "a recovered failure remains evidence without claiming business success");
  assert.deepEqual(run.episodes[0]!.appliedSkillHashes, [skillHash(spec)]);
  for (const prohibited of [secret, app, "private-session", "private-parent", "private-child", model.apiKey]) assert.equal(JSON.stringify([run.episodes, run.traces]).includes(prohibited), false);
});

test("runtime excludes skills from another model, application or expired policy", async () => {
  const base = skill();
  for (const spec of [
    { ...base, scope: { ...scope, modelProfile: "a".repeat(64) } },
    { ...base, scope: { ...scope, appDigest: "b".repeat(64) } },
    { ...base, expiresAt: 1 },
    { ...base, scope: { ...scope, hostVersion: "9.9.9" } },
  ]) {
    const run = await scenario([spec]);
    assert.equal(run.result.status, "completed");
    assert.equal(run.used.length, 0);
    assert.ok(run.requests.every(request => !request.messages[0].content.includes("Validated procedural hint")));
  }
});

test("learning observers cannot interrupt production execution or mutate frozen skill inputs", async () => {
  const spec = skill();
  const run = await scenario([spec], {
    onSkillTrace: trace => { trace.target.present = "unknown"; throw new Error(secret); },
    onSkillUsed: async () => { throw new Error(secret); },
    onFailureEpisode: async () => { throw new Error(secret); },
  });
  assert.equal(run.result.status, "completed");
  assert.match(run.requests[1]!.messages[0].content, /Validated procedural hint/);
  assert.equal(spec.program.nodes[0]!.kind, "step");
});

test("a refresh into another app invalidates the pending old-app procedure", () => {
  const session = new SkillSession({ skillSnapshot: [skill()] }, scope.hostVersion, scope.modelProfile);
  const event = DiagnosticEventSchema.parse({ schemaVersion: 1, eventType: "tool_result", runId: "00000000-0000-4000-8000-000000000001", timestamp: 1, stepIndex: 0, versions: { host: scope.hostVersion },
    actionKind: "tap_element", outcome: "failure", failureStage: "host_validation", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown", errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET" });
  session.record(event, tree(), tree(), "private-child");
  session.record({ ...event, actionKind: "get_ui_tree", outcome: "success", failureStage: "none", dispatchState: "not_applicable", acceptanceState: "not_applicable", effectState: "not_applicable", errorCode: "NONE", reason: "NONE" }, tree(), { ...tree(2), packageName: "different.app" });
  assert.deepEqual(session.consumeHints(), []);
});

test("pending recovery pins context across a missing observation and rejects changed failure observations", () => {
  const event = DiagnosticEventSchema.parse({ schemaVersion: 1, eventType: "tool_result", runId: "00000000-0000-4000-8000-000000000001", timestamp: 1, stepIndex: 0, versions: { host: scope.hostVersion },
    actionKind: "tap_element", outcome: "failure", failureStage: "host_validation", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown", errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET" });
  const read = { ...event, actionKind: "get_ui_tree", outcome: "success", failureStage: "none", dispatchState: "not_applicable", acceptanceState: "not_applicable", effectState: "not_applicable", errorCode: "NONE", reason: "NONE" } as const;
  for (const changed of [false, true]) {
    const session = new SkillSession({ skillSnapshot: [skill()] }, scope.hostVersion, scope.modelProfile);
    session.record(event, tree(), undefined, "private-child");
    session.record(read, undefined, { ...tree(2), packageName: changed ? "different.app" : app });
    assert.equal(session.consumeHints().length > 0, !changed);
  }
  const changedOnFailure = new SkillSession({ skillSnapshot: [skill()] }, scope.hostVersion, scope.modelProfile);
  changedOnFailure.record(event, tree(), { ...tree(2), windowId: 9 }, "private-child");
  assert.deepEqual(changedOnFailure.consumeHints(), []);
});

test("one task uses at most three distinct skills while allowing previously used skills", () => {
  const reasons = ["NO_CLICKABLE_TARGET", "INVALID_BOUNDS", "TARGET_CLIPPED", "AMBIGUOUS_TOUCH_TARGET"] as const;
  const specs = reasons.map(reason => SkillSpecSchema.parse({ ...skill(), trigger: { ...skill().trigger, reason } }));
  const used: string[] = [];
  const session = new SkillSession({ skillSnapshot: specs, onSkillUsed: hashes => { used.push(...hashes); } }, scope.hostVersion, scope.modelProfile);
  const event = DiagnosticEventSchema.parse({ schemaVersion: 1, eventType: "tool_result", runId: "00000000-0000-4000-8000-000000000001", timestamp: 1, stepIndex: 0, versions: { host: scope.hostVersion },
    actionKind: "tap_element", outcome: "failure", failureStage: "host_validation", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown", errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET" });
  for (const [index, reason] of reasons.entries()) {
    session.record({ ...event, reason }, tree(), tree(), "private-child");
    assert.equal(session.consumeHints().length > 0, index < 3);
  }
  session.record(event, tree(), tree(), "private-child");
  assert.ok(session.consumeHints().length);
  assert.equal(new Set(used).size, 3);
});

test("production stale failure plus adjacent host refresh enriches episode without inventing execution facts", async () => {
  let reads = 0, requests = 0;
  const episodes: FailureEpisode[] = [], traces: TraceStep[] = [];
  const initial = { ...tree(), nodes: tree().nodes.map((node: Json) => ({ ...node, resourceId: `synthetic.${node.nodeId}`, className: "android.view.View", bounds: [0, 0, 100, 50] })) };
  const refreshed = { ...initial, snapshotId: "private-session:2", revision: 2, nodes: initial.nodes.map((node: Json) => ({ ...node, nodeId: `${node.nodeId}-new`, ...(node.parentId ? { parentId: `${node.parentId}-new` } : {}), bounds: [0, 80, 100, 130] })) };
  const result = await runAgent({ task: secret, model, tools: clientTools, diagnosticVersion: "0.3.19",
    onFailureEpisode: episode => { episodes.push(episode); }, onSkillTrace: step => { traces.push(step); },
    execute: async name => name === "get_ui_tree" ? { ok: true, result: ++reads === 1 ? initial : refreshed }
      : { ok: false, error: { code: "STALE_SNAPSHOT", details: { reason: "NODE_BOUNDS_CHANGED" } } },
    modelFetch: async () => {
      const call = requests++ === 0 ? { id: "stale-action", type: "function", function: { name: "act_and_observe", arguments: JSON.stringify({ action: "tap_element", arguments: { snapshotId: initial.snapshotId, nodeId: "private-parent" } }) } } : undefined;
      return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: { role: "assistant", content: call ? null : "Synthetic stopped", ...(call ? { tool_calls: [call] } : {}) } }] }));
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(reads, 2, "the runtime refreshes without another model decision");
  assert.equal(episodes.length, 1);
  const failure = episodes[0]!.steps.find(step => step.errorCode === "STALE_SNAPSHOT")!;
  assert.equal(failure.after.complete, "yes");
  assert.deepEqual(failure.changes, { structure: "no", context: "no", focus: "no", ime: "unknown", targetBounds: "yes", targetIdentity: "no" });
  assert.equal(failure.dispatchState, "unknown");
  assert.equal(failure.acceptanceState, "unknown");
  assert.equal(failure.effectState, "unknown");
  assert.equal(traces.find(step => step.errorCode === "STALE_SNAPSHOT")!.after.hasObservation, false, "callbacks remain original live events, only the final episode is enriched");
  for (const prohibited of [secret, "private-parent", "private-session", app, "android.view.View", "bounds\":"]) assert.equal(JSON.stringify(episodes).includes(prohibited), false);
});

test("missing-state enrichment cannot cross another mutation or model decision", () => {
  const event = DiagnosticEventSchema.parse({ schemaVersion: 1, eventType: "tool_result", runId: "00000000-0000-4000-8000-000000000001", timestamp: 1, stepIndex: 0, versions: { host: scope.hostVersion },
    actionKind: "tap_element", outcome: "failure", failureStage: "unknown", dispatchState: "unknown", acceptanceState: "unknown", effectState: "unknown", errorCode: "STALE_SNAPSHOT", reason: "NODE_BOUNDS_CHANGED" });
  for (const interruption of ["mutation", "decision"] as const) {
    const episodes: FailureEpisode[] = [];
    const session = new SkillSession({ onFailureEpisode: episode => { episodes.push(episode); } }, scope.hostVersion, scope.modelProfile);
    session.record(event, tree(), undefined, "private-child");
    if (interruption === "decision") session.consumeHints();
    else session.record({ ...event, actionKind: "press_key", outcome: "success", errorCode: "NONE", reason: "NONE" });
    session.record({ ...event, actionKind: "get_ui_tree", outcome: "success", errorCode: "NONE", reason: "NONE" }, undefined, tree(2));
    session.finish("failed");
    assert.equal(episodes[0]!.steps.find(step => step.errorCode === "STALE_SNAPSHOT")!.after.hasObservation, false);
  }
});
