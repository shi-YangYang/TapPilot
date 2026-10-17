import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSkill, verifySkillReceipt, SkillEvaluationError, SKILL_FIXTURE_MODEL } from "../src/skills/evaluation.js";
import { modelScope } from "../src/learning/schema.js";
import { SkillSpecSchema, skillHash, SKILL_POLICY_REVISION, type SkillSpec } from "../src/skills/schema.js";
import { ScenarioPhone, type Json } from "../src/eval/synthetic-phone.js";
import { generateScenarios } from "../src/eval/scenarios.js";
import type { BridgeResponse } from "../src/bridge.js";
import { createEpisode, type FailureEpisode } from "../src/skills/trace.js";
import { observedPolicy, runScenario, type FixturePolicy } from "../src/eval/runner.js";

const scope = { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: modelScope(SKILL_FIXTURE_MODEL).modelProfile };
const trigger = { errorCode: "STALE_SNAPSHOT", reason: "NODE_BOUNDS_CHANGED", actionKind: "tap_element" } as const;
const facts = { hasObservation: true, complete: "yes", nodeCount: 7, actionableCount: 2, editableCount: 0, scrollableCount: 0, focusedCount: 0, focusPresent: "no", imeVisible: "unknown" } as const;
function episode(): FailureEpisode { return createEpisode({ scope, trigger, termination: "failed", appliedSkillHashes: [], steps: [{ index: 1, ...trigger, dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown", before: facts, after: facts,
  target: { present: "yes", clickable: "yes", editable: "no", scrollable: "no", ancestorClickable: "no", visible: "yes", enabled: "yes", focused: "no" },
  changes: { structure: "no", context: "no", focus: "no", ime: "unknown", targetBounds: "yes", targetIdentity: "no" } }] }); }
function candidate(): SkillSpec { return SkillSpecSchema.parse({ schemaVersion: 1, scope, trigger, entryConditions: [], basis: "hypothesis", expiresAt: Date.now() + 60_000, lineage: { negativeFeedback: [] },
  program: { entry: 0, nodes: [{ kind: "step", operation: { op: "discard_stale_target" }, next: 1 }, { kind: "step", operation: { op: "observe", mode: "reuse_latest" }, next: 2 },
    { kind: "step", operation: { op: "resolve_target", capability: "clickable", maxAncestorHops: 1 }, next: 3 }, { kind: "end", outcome: "continue" }] } }); }
// Both arms share this observation-only policy; neither can inspect phone state.
const policy: FixturePolicy = (tree, body, scenario) => {
  if (!scenario.id.startsWith("episode-") || !tree || tree.nodes.some((n: any) => n.text === "项目详情")) return observedPolicy(tree, body, scenario);
  const hint = body.messages[0].content.includes("Validated procedural hint only");
  const waited = body.messages.some((m: any) => m.tool_calls?.some((c: any) => c.function.name === "wait_for_ui_change"));
  if (!hint && !waited && !body.messages.some((m: any) => m.role === "tool" && m.content.includes('"accepted":true'))) return { name: "wait_for_ui_change", arguments: { sinceRevision: tree.revision, timeoutMs: 1 } };
  return observedPolicy(tree, body, scenario);
};

test("structural episode reproduces through runtime; paired train/holdout receipt cannot be imported", async () => {
  const spec = candidate(), trace = episode();
  const proof = await evaluateSkill(spec, trace, { fixturePolicy: policy });
  assert.ok(proof.validation.candidateRequests < proof.validation.baselineRequests);
  assert.ok(proof.validation.trainApplications >= 3 && proof.validation.holdoutApplications >= 3);
  assert.equal(proof.validation.repetitions, 3); assert.equal(proof.validation.caseCount, 24);
  assert.equal(proof.validation.contract, "structural_recovery");
  assert.deepEqual(verifySkillReceipt(spec, trace, proof.receipt), proof.validation);
  assert.throws(() => verifySkillReceipt(spec, trace, { passed: true, ...proof.validation }), /SKILLS_UNTRUSTED_RECEIPT/);
  assert.throws(() => verifySkillReceipt(spec, trace, structuredClone(proof.receipt)), /SKILLS_UNTRUSTED_RECEIPT/);
  assert.throws(() => verifySkillReceipt({ ...spec, expiresAt: spec.expiresAt + 1 }, trace, proof.receipt), /SKILLS_UNTRUSTED_RECEIPT/);
  const changed = structuredClone(trace); changed.steps[0]!.before.nodeCount++;
  assert.throws(() => verifySkillReceipt(spec, changed, proof.receipt), /SKILLS_UNTRUSTED_RECEIPT/);
});

test("reason alone and unknown intent are insufficient reproduction evidence", async () => {
  const spec = candidate(), trace = episode(); trace.steps[0]!.changes.targetIdentity = "unknown";
  await assert.rejects(evaluateSkill(spec, trace, { fixturePolicy: policy }), /SKILLS_UNREPRODUCIBLE/);
  const unknown = episode(); unknown.steps[0]!.changes.context = "unknown";
  await assert.rejects(evaluateSkill(spec, unknown, { fixturePolicy: policy }), /SKILLS_UNREPRODUCIBLE/);
  await assert.rejects(evaluateSkill(spec, { ...episode(), rawTask: "private task" }, { fixturePolicy: policy }));
});

test("unapplied, ineffective, false completion and held-out regression cannot promote", async () => {
  const spec = candidate();
  await assert.rejects(evaluateSkill({ ...spec, entryConditions: [{ fact: "nodeCount", test: "eq", value: 0 }] }, episode(), { fixturePolicy: policy }), /SKILLS_NOT_APPLIED/);
  await assert.rejects(evaluateSkill(spec, episode(), { fixturePolicy: observedPolicy }), /SKILLS_NO_IMPROVEMENT/);
  await assert.rejects(evaluateSkill(spec, episode(), { fixturePolicy: (tree, body, scenario) => {
    if (scenario.id.endsWith("holdout") && body.messages[0].content.includes("Validated procedural hint only")) {
      const decoy = tree?.nodes.find((n: any) => (n.desc ?? n.text) === "其他项目");
      if (decoy) return { name: "act_and_observe", arguments: { action: "tap_element", arguments: { snapshotId: tree!.snapshotId, nodeId: decoy.nodeId } } };
    }
    return policy(tree, body, scenario);
  } }), (error: unknown) => error instanceof SkillEvaluationError && error.code === "SKILLS_REGRESSION" && error.feedback.metric === "safety");
  await assert.rejects(evaluateSkill(spec, episode(), { fixturePolicy: (tree, body, scenario) => scenario.id.startsWith("episode-") && body.messages[0].content.includes("Validated procedural hint only") ? undefined : policy(tree, body, scenario) }),
    (error: unknown) => error instanceof SkillEvaluationError && error.code === "SKILLS_REGRESSION" && ["false_completion", "safety"].includes(error.feedback.metric));
});

test("incumbents are preserved in both arms and anonymous replay receipt remains app-bound", async () => {
  const spec = candidate(), trace = episode();
  await assert.rejects(evaluateSkill(spec, trace, { fixturePolicy: policy, incumbents: [spec] }), /SKILLS_NO_IMPROVEMENT/);
  const scoped = { ...spec, scope: { ...scope, appDigest: "a".repeat(64) } }, scopedTrace = { ...trace, scope: scoped.scope };
  const proof = await evaluateSkill(scoped, scopedTrace, { fixturePolicy: policy });
  assert.equal(proof.validation.skillHash, skillHash(scoped));
  assert.throws(() => verifySkillReceipt(spec, scopedTrace, proof.receipt), /SKILLS_UNTRUSTED_RECEIPT/);
});

test("offline budget and cancellation interrupt even an uncooperative model transport", async () => {
  const spec = candidate();
  await assert.rejects(evaluateSkill(spec, episode(), { fixturePolicy: policy, maxModelCalls: 1 }), /SKILLS_EVALUATION_BUDGET/);
  const controller = new AbortController();
  let invoked!: () => void; const started = new Promise<void>(resolve => { invoked = resolve; });
  const running = evaluateSkill(spec, episode(), { signal: controller.signal, modelFetch: async () => { invoked(); return new Promise<Response>(() => {}); } });
  await started; controller.abort(new Error("cancelled-by-test"));
  await assert.rejects(running, /cancelled-by-test/);
  await assert.rejects(evaluateSkill(spec, episode(), { maxDurationMs: 20, modelFetch: async () => new Promise<Response>(() => {}) }), /SKILLS_EVALUATION_BUDGET/);
});


test("structural and input focus transitions are generated from evidence, while changed targets are rejected", async () => {
  for (const mechanism of ["structure", "focus"] as const) {
    const trace = episode(), step = trace.steps[0]!;
    step.reason = trace.trigger.reason = mechanism === "structure" ? "TREE_STRUCTURE_CHANGED" : "NODE_STATE_CHANGED";
    if (mechanism === "structure") { step.changes.structure = "yes"; step.after = { ...step.after, nodeCount: 9 }; }
    else {
      step.target.clickable = "yes"; step.target.editable = "yes"; step.target.focused = "no";
      step.before = { ...step.before, editableCount: 1 }; step.after = { ...step.before, focusedCount: 1, focusPresent: "yes" };
      step.changes.focus = "yes";
    }
    const spec = { ...candidate(), trigger: trace.trigger };
    const proof = await evaluateSkill(spec, trace, { fixturePolicy: policy });
    assert.ok(proof.validation.trainApplications >= 3); assert.ok(proof.validation.holdoutApplications >= 3);
    assert.ok(proof.validation.candidateRequests < proof.validation.baselineRequests);
  }
  const changed = episode(); changed.steps[0]!.changes.targetIdentity = "yes";
  await assert.rejects(evaluateSkill(candidate(), changed, { fixturePolicy: policy }), /SKILLS_UNREPRODUCIBLE/);
});


test("a child replaces its deployed same-slot incumbent while preserving the baseline", async () => {
  const parent = candidate(); parent.program = { entry: 0, nodes: [{ kind: "step", operation: { op: "wait", timeoutMs: 500 }, next: 1 }, { kind: "end", outcome: "continue" }] };
  const child = candidate(); child.lineage.parentHash = skillHash(parent);
  const proof = await evaluateSkill(child, episode(), { incumbents: [parent], fixturePolicy: (tree, body, scenario) => {
    const copy = structuredClone(body);
    if (!copy.messages[0].content.includes("Use the latest returned observation directly.")) copy.messages[0].content = "base policy";
    return policy(tree, copy, scenario);
  } });
  assert.deepEqual(proof.validation.incumbentHashes, [skillHash(parent)]);
  assert.ok(proof.validation.candidateRequests < proof.validation.baselineRequests);
});


test("actual production refusals produce replayable episodes without inventing dispatch evidence", async () => {
  for (const hostRefusal of [false, true]) {
    class ObservedFailurePhone extends ScenarioPhone {
      changed = false;
      override snapshot(): Json {
        const tree = super.snapshot();
        if (hostRefusal && this.reads >= 2) this.changed = true;
        if (this.changed && this.state.page !== "detail") {
          const target = tree.nodes.find((n: any) => n.resourceId.endsWith(hostRefusal ? "/title" : "/target"));
          if (hostRefusal) target.text = "更新后的合成工作台";
          else target.bounds = target.bounds.map((v: number, i: number) => v + (i % 2 ? 24 : 0));
        }
        return tree;
      }
      override async call(method: string, args: Json = {}, timeout?: number, beforeDispatch?: () => void): Promise<BridgeResponse> {
        if (!hostRefusal && method === "act_and_observe" && !this.changed) {
          beforeDispatch?.(); this.changed = true;
          return { id: "fixture", ok: false, error: { code: "STALE_SNAPSHOT", message: "Synthetic snapshot conflict", retryable: true, details: { reason: "NODE_BOUNDS_CHANGED" } }, meta: { durationMs: 1 } };
        }
        return super.call(method, args, timeout, beforeDispatch);
      }
    }
    let trace: FailureEpisode | undefined;
    const source = generateScenarios({ mechanisms: ["fresh_ids"] })[0]!;
    await runScenario(source, { diagnosticVersion: "0.3.19", phoneFactory: scenario => new ObservedFailurePhone(scenario), onFailureEpisode: value => { trace = value; } });
    assert.ok(trace);
    assert.equal(trace.trigger.errorCode, hostRefusal ? "TARGET_CHANGED" : "STALE_SNAPSHOT");
    const failure = trace.steps.find(step => step.errorCode === trace!.trigger.errorCode)!;
    assert.equal(failure.acceptanceState, hostRefusal ? "rejected" : "unknown");
    assert.equal(failure.dispatchState, hostRefusal ? "not_sent" : "unknown");
    assert.equal(failure.changes.context, "no"); assert.equal(failure.changes.targetIdentity, "no");
    if (!hostRefusal) assert.equal(failure.changes.targetBounds, "yes");
    const spec = { ...candidate(), scope: trace.scope, trigger: trace.trigger };
    if (hostRefusal) {
      // Native node-v1 proves non-dispatch, but does not expose enough structural
      // evidence to certify a learned context recovery. Keep this unadoptable.
      assert.equal(failure.contextChange, undefined);
      await assert.rejects(evaluateSkill(spec, trace, { fixturePolicy: policy }), /SKILLS_UNREPRODUCIBLE/);
    } else {
      const proof = await evaluateSkill(spec, trace, { fixturePolicy: policy });
      assert.ok(proof.validation.candidateRequests < proof.validation.baselineRequests);
    }
  }
});
