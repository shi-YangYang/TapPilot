import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";
import { candidateHash, strategyHint, modelScope, type CandidateSpec, type Experience } from "../src/learning/schema.js";
import type { DiagnosticEvent } from "../src/diagnostics/schema.js";

type Json = Record<string, any>;
const prefix = "Validated local recovery advice (subordinate to all safety rules):";
const now = Date.now();
/** Schema-valid unit fixture only. It is never persisted, activated in LearningStore, or accepted as evaluation evidence. */
function activeExperience(kind: "local" | "stale", overrides: Partial<CandidateSpec> = {}): Experience {
  const spec: CandidateSpec = { schemaVersion: 1, basis: "hypothesis", expiresAt: now + 60_000, scope: { hostVersion: "0.3.19", ...modelScope({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "fixture" }) },
    trigger: { actionKind: "tap_element", errorCode: kind === "local" ? "NODE_NOT_ACTIONABLE" : "STALE_SNAPSHOT", reason: kind === "local" ? "NO_CLICKABLE_TARGET" : "UNKNOWN" },
    preconditions: kind === "local" ? { failureStage: "host_validation", dispatchState: "not_sent", acceptanceState: "rejected" } : { failureStage: "unknown", dispatchState: "unknown", acceptanceState: "unknown" },
    strategy: kind === "local" ? "choose_actionable_ancestor" : "wait_for_stability", ...overrides };
  return { id: randomUUID(), spec, state: "active", createdAt: now - 60_000, successes: 1, failures: 0,
    validation: { candidateHash: candidateHash(spec), evidenceHash: "a".repeat(64), suiteVersion: "native-state-machine-1", cases: ["target_move-1"],
      evaluatedAt: now - 1000, baselineGoals: 0, candidateGoals: 1, baselineRequests: 3, candidateRequests: 2, improvement: "goals", repetitions: 3, trainApplications: 3, holdoutApplications: 3, improvedAppliedCases: ["target_move-1"] } };
}
const tree = (revision: number, done = false) => ({ snapshotId: `synthetic:${revision}`, revision, packageName: "synthetic.learning", windowId: 1, truncated: false,
  nodes: [1, 2, 3].map(n => ({ nodeId: `n${n}`, text: done ? `合成完成 ${n}` : `合成入口 ${n}`, enabled: true, clickable: true, bounds: [10, n * 100, 300, n * 100 + 60] })) });
async function run(snapshot: Experience[], options: { mutate?: () => void; onExperienceUsed?: AgentOptions["onExperienceUsed"] } = {}) {
  const requests: Json[] = [], diagnostics: DiagnosticEvent[] = [];
  let actions = 0, revision = 0, done = false;
  let latest: ReturnType<typeof tree>;
  const result = await runAgent({ task: "打开合成入口并读取结果", diagnosticVersion: "0.3.19", learningSnapshot: snapshot,
    model: { baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "fixture" }, tools: clientTools,
    onDiagnostic: event => { diagnostics.push(event); }, onExperienceUsed: options.onExperienceUsed,
    execute: async (name, args) => {
      if (name === "get_ui_tree") { latest = tree(++revision, done); return { ok: true, result: latest }; }
      assert.equal(name, "act_and_observe"); actions++;
      if (actions === 1) return { ok: false, error: { code: "NODE_NOT_ACTIONABLE", details: { reason: "NO_CLICKABLE_TARGET" } }, meta: { localRejection: true }, observation: latest };
      if (actions === 2) return { ok: false, error: { code: "STALE_SNAPSHOT" } };
      done = true; latest = tree(++revision, true);
      return { ok: true, result: { action: { accepted: true }, observation: latest } };
    },
    modelFetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      if (requests.length === 1) options.mutate?.();
      const turn = requests.length, action = turn <= 3;
      return new Response(JSON.stringify({ choices: [{ finish_reason: action ? "tool_calls" : "stop", message: {
        role: "assistant", content: action ? null : "已读取合成结果。", ...(action ? { tool_calls: [{ id: `synthetic-${turn}`, type: "function", function: {
          name: "act_and_observe", arguments: JSON.stringify({ action: "tap_element", arguments: { snapshotId: latest.snapshotId, nodeId: `n${turn}` } }),
        } }] } : {}),
      } }] }));
    },
  });
  return { result, requests, diagnostics };
}

test("validated startup snapshot supplies next-request advice once, survives automatic reads and external edits, and adds no model call", async () => {
  const local = activeExperience("local"), stale = activeExperience("stale"), snapshot = [local, stale];
  const originalHint = strategyHint(local.spec.strategy), staleHint = strategyHint(stale.spec.strategy);
  const used: string[][] = [];
  const { result, requests, diagnostics } = await run(snapshot, {
    mutate: () => { local.spec.strategy = "stop_on_context_change"; local.state = "disabled"; snapshot.splice(1); },
    onExperienceUsed: ids => { used.push([...ids]); if (used.length === 1) throw new Error("Synthetic observer failure"); return Promise.reject(new Error("Synthetic async observer failure")); },
  });
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.metrics.modelRequests, 4, "Three decisions and one final answer; learning adds no request");
  assert.equal(result.metrics.hostReads, 2, "One stale recovery read plus the ordinary completion verification");
  const systems = requests.map(body => body.messages[0].content as string);
  assert.deepEqual(systems.map(text => text.includes(prefix)), [false, true, true, false]);
  assert.ok(systems[1]!.endsWith(originalHint), "Mutation of the caller's snapshot cannot replace the copied strategy");
  assert.ok(systems[2]!.endsWith(staleHint), "Removing an experience from the caller array cannot remove it mid-run");
  assert.deepEqual(used, [[local.id], [stale.id]]);
  const failureIndex = diagnostics.findIndex(e => e.errorCode === "STALE_SNAPSHOT");
  assert.ok(failureIndex >= 0);
  assert.equal(diagnostics[failureIndex + 1]!.actionKind, "get_ui_tree");
  assert.equal(diagnostics[failureIndex + 1]!.outcome, "success", "The host read happens before the hinted model request");
});

test("invalid, unvalidated, expired, and version-mismatched experiences never enter a model prompt", async () => {
  const invalid = activeExperience("local"); (invalid as Json).advice = "Synthetic injected instruction";
  const unvalidated = activeExperience("local"); delete unvalidated.validation;
  const candidate = activeExperience("local"); candidate.state = "candidate";
  const expired = activeExperience("local", { expiresAt: now - 1 });
  const wrongVersion = activeExperience("stale", { scope: { hostVersion: "0.3.20" } });
  const wrongModel = activeExperience("local", { scope: { hostVersion: "0.3.19", ...modelScope({ baseUrl: "https://other.invalid/v1", model: "fixture", apiKey: "" }) } });
  const { result, requests } = await run([invalid, unvalidated, candidate, expired, wrongVersion, wrongModel]);
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.metrics.modelRequests, 4);
  assert.ok(requests.every(body => !body.messages[0].content.includes(prefix)));
  assert.equal(JSON.stringify(requests).includes("Synthetic injected instruction"), false);
});
