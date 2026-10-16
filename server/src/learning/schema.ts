import { createHash } from "node:crypto";
import { z } from "zod";
import { ActionKindSchema, DiagnosticErrorCodeSchema, DiagnosticReasonSchema, DiagnosticEventSchema } from "../diagnostics/schema.js";
import { endpointFor, type ModelConfig } from "../runtime/model.js";
export const StrategySchema = z.enum(["wait_for_stability", "choose_actionable_ancestor", "use_latest_observation", "confirm_effect_before_retry", "stop_on_context_change", "disambiguate_target"]);
export const ModelFamilySchema = z.enum(["openai", "anthropic", "deepseek", "qwen", "local", "other"]);
export const ModelProfileSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Bind advice to the actual configured endpoint/model without storing either or an API key. */
export function modelScope(model: ModelConfig): { modelFamily: z.infer<typeof ModelFamilySchema>; modelProfile: string } {
  const endpoint = endpointFor(model), url = new URL(endpoint), name = model.model.trim();
  const lower = name.toLowerCase();
  const modelFamily: z.infer<typeof ModelFamilySchema> = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? "local"
    : /(^|\/)deepseek/.test(lower) ? "deepseek" : /(^|\/)claude/.test(lower) ? "anthropic"
      : /(^|\/)qwen/.test(lower) ? "qwen" : /(^|\/)(gpt[-\d]|o[134](?:-|$))/.test(lower) ? "openai" : "other";
  return { modelFamily, modelProfile: createHash("sha256").update(JSON.stringify([endpoint, name])).digest("hex") };
}
const version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const count = z.number().int().min(0).max(1_000_000);
export const TriggerSchema = z.object({ errorCode: DiagnosticErrorCodeSchema, reason: DiagnosticReasonSchema, actionKind: ActionKindSchema }).strict();
export const PreconditionsSchema = z.object({
  failureStage: DiagnosticEventSchema.shape.failureStage,
  dispatchState: DiagnosticEventSchema.shape.dispatchState,
  acceptanceState: DiagnosticEventSchema.shape.acceptanceState,
}).strict();
export const CandidateSpecSchema = z.object({
  schemaVersion: z.literal(1), trigger: TriggerSchema, preconditions: PreconditionsSchema,
  strategy: StrategySchema, scope: z.object({ hostVersion: version, modelFamily: ModelFamilySchema.optional(), modelProfile: ModelProfileSchema.optional() }).strict(),
  basis: z.literal("hypothesis"), expiresAt: timestamp,
}).strict();
export const SyntheticCaseIdSchema = z.string().regex(/^(fresh_ids|target_move|unrelated_updates|duplicate_labels|clickable_parent|overlap|nested_scroll|ime_layout|slow_loading|lost_response|session_change|cancel_protected)-(?:[1-9]|10)$/);
export const ValidationSchema = z.object({ candidateHash: z.string().regex(/^[a-f0-9]{64}$/), suiteVersion: z.string().regex(/^native-state-machine-\d+$/),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/), cases: z.array(SyntheticCaseIdSchema).min(1).max(120),
  evaluatedAt: timestamp, baselineGoals: count, candidateGoals: count, baselineRequests: count, candidateRequests: count,
  improvement: z.enum(["goals", "model_requests", "ui_bytes"]),
  repetitions: z.literal(3), trainApplications: count, holdoutApplications: count,
  improvedAppliedCases: z.array(SyntheticCaseIdSchema).min(1).max(120),
}).strict();
export const ExperienceSchema = z.object({ id: z.string().uuid(), spec: CandidateSpecSchema,
  state: z.enum(["candidate", "validated", "active", "disabled"]), createdAt: timestamp,
  successes: count, failures: count, validation: ValidationSchema.optional(),
}).strict().superRefine((entry, context) => {
  if ((entry.state === "validated" || entry.state === "active") && !entry.validation) context.addIssue({ code: z.ZodIssueCode.custom, message: "validation_required" });
  if (entry.spec.expiresAt <= entry.createdAt) context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_expiry" });
  if (entry.validation && entry.validation.candidateHash !== candidateHash(entry.spec)) context.addIssue({ code: z.ZodIssueCode.custom, message: "validation_mismatch" });
});
export type CandidateSpec = z.infer<typeof CandidateSpecSchema>;
export type Experience = z.infer<typeof ExperienceSchema>;
export type Trigger = z.infer<typeof TriggerSchema> & Partial<z.infer<typeof PreconditionsSchema>>;
export type FrozenSnapshot = readonly Readonly<Experience>[];
export function candidateHash(spec: CandidateSpec | Experience): string {
  const value = "spec" in spec ? spec.spec : spec;
  return createHash("sha256").update(JSON.stringify(CandidateSpecSchema.parse(value))).digest("hex");
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
const strategyText: Record<z.infer<typeof StrategySchema>, string> = {
  wait_for_stability: "If the target is still loading or moving, wait once for relevant UI evidence, then choose again from the returned observation. Do not replay a dispatched action.",
  choose_actionable_ancestor: "Use an observed clickable ancestor only when it uniquely represents the intended control. Never invent coordinates or route around a rejected target.",
  use_latest_observation: "Use the UI already returned by the last action. Read again only when the observation is missing, incomplete, or explicitly invalidated.",
  confirm_effect_before_retry: "An accepted action or lost response may already have changed the phone. Verify its effect before deciding; never automatically replay the mutation.",
  stop_on_context_change: "A changed session, recipient, or protected context invalidates the old intent. Stop and report the limitation instead of applying the old action.",
  disambiguate_target: "Distinguish repeated labels using the current observed hierarchy and semantics. If the intended target is not unique, stop without touching it.",
};
export function matchesSpec(spec: CandidateSpec, trigger: Trigger): boolean {
  return Object.entries(spec.trigger).every(([key, value]) => trigger[key as keyof Trigger] === value)
    && Object.entries(spec.preconditions).every(([key, value]) => trigger[key as keyof Trigger] === value);
}
export function strategyHint(strategy: CandidateSpec["strategy"]): string { return strategyText[StrategySchema.parse(strategy)]; }
export function semanticFingerprint(spec: CandidateSpec): string {
  const { expiresAt: _expiry, ...semantic } = CandidateSpecSchema.parse(spec);
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}
export function retrieve(snapshot: FrozenSnapshot, trigger: Trigger): FrozenSnapshot {
  return snapshot.filter(entry => entry.state === "active" && matchesSpec(entry.spec, trigger))
    .sort((a, b) => b.successes - a.successes || a.failures - b.failures || a.createdAt - b.createdAt).slice(0, 3);
}
export function strategyHints(entries: FrozenSnapshot): string[] {
  return [...new Set(entries.slice(0, 3).map(entry => strategyHint(entry.spec.strategy)))];
}
