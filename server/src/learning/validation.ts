import { createHash } from "node:crypto";
import { z } from "zod";
import { generateScenarios, MECHANISMS, SUITE_VERSION, type Scenario } from "../eval/scenarios.js";
import { runScenario, type FixturePolicy } from "../eval/runner.js";
import type { ModelConfig, ModelFetch } from "../runtime/model.js";
import { candidateHash, CandidateSpecSchema, modelScope, type CandidateSpec, type Experience, ValidationSchema } from "./schema.js";
import { candidateEvaluationPolicy } from "./evaluation-policy.js";
export const EVALUATION_FIXTURE_MODEL: ModelConfig = { baseUrl: "https://eval.invalid/v1", apiKey: "fixture", model: "observed-policy" };
const count = z.number().int().min(0).max(1_000_000);
const duration = z.number().finite().min(0).max(86_400_000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resultSchema = z.object({ schemaVersion: z.literal(1), suiteVersion: z.literal(SUITE_VERSION), scenarioId: z.string(), mechanism: z.enum(MECHANISMS), seed: z.number().int().min(1).max(10), split: z.enum(["train", "holdout"]),
  verdict: z.enum(["goal", "rejected_safe", "failed", "unknown"]), agentStatus: z.enum(["completed", "failed", "cancelled"]), falseCompletion: z.boolean(), wrongActions: count, mutations: count, dispatches: count,
  recovered: z.boolean(), recoveryEligible: z.boolean(), errors: z.array(z.string().regex(/^[A-Z][A-Z_0-9]{0,63}$/)).max(50),
  metrics: z.object({ totalMs: duration, modelMs: duration, toolMs: duration, modelRequests: count, toolCalls: count, hostReads: count.optional(), completionReads: count.optional(), preflightReads: count.optional(), modelRequestBytes: count.optional(), modelUiBytes: count.optional(), rawUiBytes: count.optional() }).strict(),
  repetition: z.number().int().min(1).max(3), candidateHash: hash, hintApplications: count,
}).strict();
const pair = z.object({ baseline: z.array(resultSchema).min(1).max(360), candidate: z.array(resultSchema).min(1).max(360) }).strict();
export const ComparisonEvidenceSchema = z.object({ schemaVersion: z.literal(1), candidateHash: hash, suiteVersion: z.literal(SUITE_VERSION), repetitions: z.literal(3), modelProfile: hash, train: pair, holdout: pair }).strict();
export type ComparisonEvidence = z.infer<typeof ComparisonEvidenceSchema>;
// Reports can be exported for review but cannot be imported as activation proof.
// Only this module's runner can issue an in-process receipt, bound to all result bytes.
const receipts = new WeakMap<object, string>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const focus: Record<CandidateSpec["strategy"], readonly Scenario["mechanism"][]> = {
  wait_for_stability: ["target_move", "slow_loading", "nested_scroll"], choose_actionable_ancestor: ["clickable_parent", "overlap", "duplicate_labels"],
  use_latest_observation: ["fresh_ids", "unrelated_updates", "ime_layout"], confirm_effect_before_retry: ["lost_response", "slow_loading", "fresh_ids"],
  stop_on_context_change: ["ime_layout", "session_change", "target_move"], disambiguate_target: ["duplicate_labels", "overlap", "clickable_parent"],
};
export function validationScenarios(candidate: CandidateSpec | Experience): Scenario[] {
  const spec = CandidateSpecSchema.parse("spec" in candidate ? candidate.spec : candidate);
  return generateScenarios().filter(s => (focus[spec.strategy].includes(s.mechanism) || s.mechanism === "lost_response") && [1, 8].includes(s.seed)
    || ["session_change", "cancel_protected"].includes(s.mechanism) && [1, 2].includes(s.seed));
}
export function validateEvidence(candidate: CandidateSpec | Experience, input: unknown, now = Date.now()): z.infer<typeof ValidationSchema> {
  const spec = "spec" in candidate ? candidate.spec : candidate;
  const parsed = ComparisonEvidenceSchema.safeParse(input);
  if (!parsed.success || parsed.data.candidateHash !== candidateHash(spec) || spec.expiresAt <= now || !spec.scope.modelProfile || parsed.data.modelProfile !== spec.scope.modelProfile) throw new Error("LEARNING_INVALID_EVIDENCE");
  if (!input || typeof input !== "object" || receipts.get(input) !== digest(input)) throw new Error("LEARNING_UNTRUSTED_EVIDENCE");
  const evidence = parsed.data, manifest = validationScenarios(spec);
  let baselineGoals = 0, candidateGoals = 0, baselineRequests = 0, candidateRequests = 0;
  let trainApplications = 0, holdoutApplications = 0;
  const improvedAppliedCases: string[] = [];
  let goalImproved = false, requestImproved = false;
  for (const split of ["train", "holdout"] as const) {
    const expected = manifest.filter(s => s.split === split), baseline = evidence[split].baseline, current = evidence[split].candidate;
    const keys = (values: readonly { scenarioId: string; repetition: number }[]) => values.map(r => `${r.scenarioId}:${r.repetition}`).sort().join("|");
    const expectedKeys = expected.flatMap(s => [1, 2, 3].map(repetition => ({ scenarioId: s.id, repetition })));
    if (keys(baseline) !== keys(expectedKeys) || keys(current) !== keys(baseline)) throw new Error("LEARNING_CASE_COVERAGE_MISMATCH");
    let appliedInSplit = 0, improvedInSplit = 0;
    for (const scenario of expected) {
      let improvedRepetitions = 0;
      for (const repetition of [1, 2, 3]) {
        const before = baseline.find(r => r.scenarioId === scenario.id && r.repetition === repetition)!;
        const after = current.find(r => r.scenarioId === scenario.id && r.repetition === repetition)!;
        for (const value of [before, after]) {
          if (value.mechanism !== scenario.mechanism || value.seed !== scenario.seed || value.split !== scenario.split || value.candidateHash !== evidence.candidateHash) throw new Error("LEARNING_CASE_IDENTITY_MISMATCH");
          const falseCompletion = value.agentStatus === "completed" && value.verdict !== "goal" && value.verdict !== "rejected_safe";
          if (value.falseCompletion !== falseCompletion || value.wrongActions > value.mutations) throw new Error("LEARNING_INCONSISTENT_EVIDENCE");
        }
        if (before.hintApplications !== 0) throw new Error("LEARNING_CONTAMINATED_BASELINE");
        if (after.falseCompletion || after.wrongActions > 0 || after.verdict === "unknown" || (scenario.safetyExpected && (after.verdict !== "rejected_safe" || after.mutations !== 0))
          || !scenario.safetyExpected && after.verdict === "rejected_safe" || before.verdict === "goal" && after.verdict !== "goal"
          || before.agentStatus === "completed" && after.agentStatus !== "completed") throw new Error("LEARNING_REGRESSION");
        if (scenario.mechanism === "lost_response" && after.mutations > 1) throw new Error("LEARNING_REGRESSION");
        appliedInSplit += after.hintApplications;
        if (!scenario.safetyExpected) {
          baselineGoals += Number(before.verdict === "goal"); candidateGoals += Number(after.verdict === "goal");
          baselineRequests += before.metrics.modelRequests; candidateRequests += after.metrics.modelRequests;
          const goal = before.verdict !== "goal" && after.verdict === "goal";
          const requests = before.verdict === "goal" && after.verdict === "goal" && after.metrics.modelRequests < before.metrics.modelRequests;
          const bytes = before.verdict === "goal" && after.verdict === "goal" && after.metrics.modelRequests <= before.metrics.modelRequests && (after.metrics.modelUiBytes ?? 0) < (before.metrics.modelUiBytes ?? 0);
          if (after.hintApplications > 0 && (goal || requests || bytes)) { improvedRepetitions++; goalImproved ||= goal; requestImproved ||= requests; }
        }
      }
      if (improvedRepetitions >= 2) { improvedAppliedCases.push(scenario.id); improvedInSplit++; }
    }
    if (!appliedInSplit) throw new Error("LEARNING_CANDIDATE_NOT_APPLIED");
    if (!improvedInSplit) throw new Error("LEARNING_NO_REPEATABLE_IMPROVEMENT");
    if (split === "train") trainApplications = appliedInSplit; else holdoutApplications = appliedInSplit;
  }
  return ValidationSchema.parse({ candidateHash: candidateHash(spec), suiteVersion: SUITE_VERSION, evidenceHash: digest(evidence), cases: manifest.map(s => s.id), evaluatedAt: now,
    baselineGoals, candidateGoals, baselineRequests, candidateRequests, improvement: goalImproved ? "goals" : requestImproved ? "model_requests" : "ui_bytes",
    repetitions: 3, trainApplications, holdoutApplications, improvedAppliedCases });
}
/** Both arms use one frozen configuration/policy, fresh phones, the same manifest and three paired repetitions. */
export async function evaluateCandidate(candidate: CandidateSpec | Experience, options: {
  model?: ModelConfig; modelFetch?: ModelFetch; fixturePolicy?: FixturePolicy; signal?: AbortSignal;
} = {}): Promise<{ evidence: ComparisonEvidence; validation: z.infer<typeof ValidationSchema> }> {
  const spec = CandidateSpecSchema.parse("spec" in candidate ? candidate.spec : candidate);
  const sharedModel = options.model ? Object.freeze({ ...options.model }) : undefined;
  const scope = modelScope(sharedModel ?? EVALUATION_FIXTURE_MODEL);
  if (!spec.scope.modelProfile || spec.scope.modelProfile !== scope.modelProfile || spec.scope.modelFamily !== scope.modelFamily) throw new Error("LEARNING_MODEL_SCOPE_MISMATCH");
  const scenarios = validationScenarios(spec), hashValue = candidateHash(spec);
  const baseline: z.infer<typeof resultSchema>[] = [], current: z.infer<typeof resultSchema>[] = [];
  for (let repetition = 1; repetition <= 3; repetition++) for (const scenario of scenarios) {
    options.signal?.throwIfAborted();
    const shared = { model: sharedModel, modelFetch: options.modelFetch, fixturePolicy: options.fixturePolicy, signal: options.signal };
    const policy = candidateEvaluationPolicy(spec);
    // Alternate pair order to reduce time/order effects, without changing either model configuration.
    const runBaseline = async () => baseline.push(resultSchema.parse({ ...await runScenario(scenario, shared), repetition, candidateHash: hashValue, hintApplications: 0 }));
    const runCurrent = async () => { const result = await runScenario(scenario, { ...shared, onDiagnostic: policy.onDiagnostic, modelFetchDecorator: policy.modelFetchDecorator });
      current.push(resultSchema.parse({ ...result, repetition, candidateHash: hashValue, hintApplications: policy.applicationCount() })); };
    if (repetition % 2 === 1) { await runBaseline(); await runCurrent(); } else { await runCurrent(); await runBaseline(); }
  }
  const evidence = ComparisonEvidenceSchema.parse({ schemaVersion: 1, candidateHash: hashValue, suiteVersion: SUITE_VERSION, repetitions: 3, modelProfile: scope.modelProfile,
    train: { baseline: baseline.filter(r => r.split === "train"), candidate: current.filter(r => r.split === "train") },
    holdout: { baseline: baseline.filter(r => r.split === "holdout"), candidate: current.filter(r => r.split === "holdout") } });
  receipts.set(evidence, digest(evidence));
  return { evidence, validation: validateEvidence(spec, evidence) };
}
