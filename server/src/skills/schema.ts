import { createHash } from "node:crypto";
import { z } from "zod";
import { ActionKindSchema, DiagnosticErrorCodeSchema, DiagnosticReasonSchema } from "../diagnostics/schema.js";

export const SKILL_POLICY_REVISION = "skill-policy-1" as const;
export const SkillHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const SkillScopeSchema = z.object({
  hostVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  policyRevision: z.literal(SKILL_POLICY_REVISION), modelProfile: SkillHashSchema,
  appDigest: SkillHashSchema.optional(),
}).strict();
export type SkillScope = z.infer<typeof SkillScopeSchema>;
export const SkillTriggerSchema = z.object({ errorCode: DiagnosticErrorCodeSchema, reason: DiagnosticReasonSchema, actionKind: ActionKindSchema }).strict();
export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;
export const EvidenceFlagSchema = z.enum(["yes", "no", "unknown"]);
const count = z.number().int().min(0).max(10_000);
export const ObservationFactsSchema = z.object({
  hasObservation: z.boolean(), complete: EvidenceFlagSchema, nodeCount: count, actionableCount: count,
  editableCount: count, scrollableCount: count, focusedCount: count,
  focusPresent: EvidenceFlagSchema, imeVisible: EvidenceFlagSchema,
}).strict();
export type ObservationFacts = z.infer<typeof ObservationFactsSchema>;
export const TargetFactsSchema = z.object({
  present: EvidenceFlagSchema, clickable: EvidenceFlagSchema, editable: EvidenceFlagSchema,
  scrollable: EvidenceFlagSchema, ancestorClickable: EvidenceFlagSchema, visible: EvidenceFlagSchema,
  enabled: EvidenceFlagSchema, focused: EvidenceFlagSchema,
}).strict();
export type TargetFacts = z.infer<typeof TargetFactsSchema>;
export const SkillFactsSchema = ObservationFactsSchema.extend({
  structureChanged: EvidenceFlagSchema, contextChanged: EvidenceFlagSchema, focusChanged: EvidenceFlagSchema,
  imeChanged: EvidenceFlagSchema, priorActionAccepted: EvidenceFlagSchema, priorEffectUnknown: EvidenceFlagSchema,
  targetPresent: EvidenceFlagSchema, targetClickable: EvidenceFlagSchema, targetEditable: EvidenceFlagSchema,
  targetScrollable: EvidenceFlagSchema, targetAncestorClickable: EvidenceFlagSchema,
  targetVisible: EvidenceFlagSchema, targetEnabled: EvidenceFlagSchema, targetFocused: EvidenceFlagSchema,
}).strict();
export type SkillFacts = z.infer<typeof SkillFactsSchema>;
export const PredicateSchema = z.union([
  z.object({ fact: z.enum(["nodeCount", "actionableCount", "editableCount", "scrollableCount", "focusedCount"]), test: z.enum(["eq", "gte", "lte"]), value: count }).strict(),
  z.object({ fact: z.literal("hasObservation"), test: z.literal("eq"), value: z.boolean() }).strict(),
  z.object({ fact: z.enum(["complete", "focusPresent", "imeVisible", "structureChanged", "contextChanged", "focusChanged", "imeChanged", "priorActionAccepted", "priorEffectUnknown", "targetPresent", "targetClickable", "targetEditable", "targetScrollable", "targetAncestorClickable", "targetVisible", "targetEnabled", "targetFocused"]), test: z.literal("eq"), value: EvidenceFlagSchema }).strict(),
]);
export type SkillPredicate = z.infer<typeof PredicateSchema>;

/** Programs can compose new procedures, but cannot introduce executable code,
 * user-facing text, coordinates, target identities, or additional authority. */
export const SkillOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("observe"), mode: z.enum(["reuse_latest", "refresh_if_missing", "refresh_if_incomplete"]) }).strict(),
  z.object({ op: z.literal("wait"), timeoutMs: z.union([z.literal(250), z.literal(500), z.literal(1000)]) }).strict(),
  z.object({ op: z.literal("resolve_target"), capability: z.enum(["clickable", "editable", "scrollable"]), maxAncestorHops: z.number().int().min(0).max(3) }).strict(),
  z.object({ op: z.literal("inspect"), aspect: z.enum(["hierarchy", "focus_and_ime", "overlap", "context"]) }).strict(),
  z.object({ op: z.literal("focus_existing_input") }).strict(),
  z.object({ op: z.literal("input_requested_text"), source: z.literal("current_task_requested_text") }).strict(),
  z.object({ op: z.literal("activate_resolved_target"), target: z.literal("current_task_target") }).strict(),
  z.object({ op: z.literal("scroll_resolved_container"), direction: z.enum(["forward", "backward"]), count: z.literal(1) }).strict(),
  z.object({ op: z.literal("verify_effect"), evidence: z.enum(["current_observation", "focused_input", "target_state"]) }).strict(),
  z.object({ op: z.literal("discard_stale_target") }).strict(),
]);
export type SkillOperation = z.infer<typeof SkillOperationSchema>;
const ref = z.number().int().min(0).max(7);
export const SkillNodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), operation: SkillOperationSchema, next: ref }).strict(),
  z.object({ kind: z.literal("branch"), condition: PredicateSchema, yes: ref, no: ref }).strict(),
  z.object({ kind: z.literal("end"), outcome: z.enum(["continue", "stop"]) }).strict(),
]);
export const SkillProgramSchema = z.object({ entry: z.literal(0), nodes: z.array(SkillNodeSchema).min(2).max(8) }).strict().superRefine((program, context) => {
  const reached = new Set<number>([0]);
  for (let i = 0; i < program.nodes.length; i++) {
    const node = program.nodes[i]!;
    const successors = node.kind === "step" ? [node.next] : node.kind === "branch" ? [node.yes, node.no] : [];
    for (const next of successors) {
      if (next <= i || next >= program.nodes.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_forward_reference", path: ["nodes", i] });
      if (reached.has(i)) reached.add(next);
    }
    if (!reached.has(i)) context.addIssue({ code: z.ZodIssueCode.custom, message: "unreachable_node", path: ["nodes", i] });
  }
  if (!program.nodes.some(node => node.kind === "step")) context.addIssue({ code: z.ZodIssueCode.custom, message: "procedure_required" });
});
export const SkillFeedbackSchema = z.object({
  skillHash: SkillHashSchema, outcome: z.enum(["evaluation_rejected", "runtime_failure", "regression", "no_improvement"]),
  errorCode: DiagnosticErrorCodeSchema, reason: DiagnosticReasonSchema,
  metric: z.enum(["goal_success", "safety", "false_completion", "model_requests", "ui_bytes", "unknown"]),
}).strict();
export type SkillFeedback = z.infer<typeof SkillFeedbackSchema>;
export const SkillSpecSchema = z.object({
  schemaVersion: z.literal(1), scope: SkillScopeSchema, trigger: SkillTriggerSchema,
  entryConditions: z.array(PredicateSchema).max(6), program: SkillProgramSchema,
  lineage: z.object({ parentHash: SkillHashSchema.optional(), negativeFeedback: z.array(SkillFeedbackSchema).max(8) }).strict(),
  basis: z.literal("hypothesis"), expiresAt: z.number().int().min(0).max(8_640_000_000_000_000),
}).strict();
export type SkillSpec = z.infer<typeof SkillSpecSchema>;
export function skillHash(input: SkillSpec): string { return createHash("sha256").update(JSON.stringify(SkillSpecSchema.parse(input))).digest("hex"); }
export function semanticSkillHash(input: SkillSpec): string {
  const { expiresAt: _expiresAt, lineage: _lineage, ...semantic } = SkillSpecSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}
export function matchesScope(scope: SkillScope, current: SkillScope): boolean {
  return scope.hostVersion === current.hostVersion && scope.policyRevision === current.policyRevision && scope.modelProfile === current.modelProfile && (!scope.appDigest || scope.appDigest === current.appDigest);
}
export function predicateMatches(predicate: SkillPredicate, facts: SkillFacts): boolean {
  const value = facts[predicate.fact];
  if (predicate.test === "eq") return value === predicate.value;
  return typeof value === "number" && (predicate.test === "gte" ? value >= predicate.value : value <= predicate.value);
}
export function matchesSkill(spec: SkillSpec, trigger: SkillTrigger, facts: SkillFacts): boolean {
  return spec.trigger.errorCode === trigger.errorCode && spec.trigger.reason === trigger.reason && spec.trigger.actionKind === trigger.actionKind && spec.entryConditions.every(p => predicateMatches(p, facts));
}
function operationText(operation: SkillOperation): string {
  switch (operation.op) {
    case "observe": return operation.mode === "reuse_latest" ? "Use the latest returned observation directly." : operation.mode === "refresh_if_missing" ? "Read once only if the current observation is missing." : "Read once only if the current observation is missing or incomplete.";
    case "wait": return `If relevant evidence is still needed, wait once for UI change for at most ${operation.timeoutMs} ms; use the returned observation directly.`;
    case "resolve_target": return `Resolve the current task's intended ${operation.capability} control from the latest hierarchy${operation.maxAncestorHops ? `, inspecting at most ${operation.maxAncestorHops} observed ancestors` : " without changing to an ancestor"}. Proceed only when intent and target are unique and unchanged; otherwise stop. Never reuse old node IDs or coordinates.`;
    case "inspect": return ({ hierarchy: "Inspect the currently observed target hierarchy and distinguish repeated labels before acting.", focus_and_ime: "Check observed focus and input-method layout; treat missing keyboard evidence as unknown.", overlap: "Check observed overlap and target visibility; stop if the intended touch target remains ambiguous.", context: "Check the current app, session and recipient context; stop if intent or context changed." })[operation.aspect];
    case "focus_existing_input": return "Only if the current user task requires input, the intended editable field is unique and unfocused, and no prior action has an unknown effect, focus that observed field through the existing guarded phone tool; inspect its returned observation before any input.";
    case "input_requested_text": return "Only when required by the current task, re-resolve its unique focused editable field after layout changes and pass the already user-requested text to input_text using the latest snapshot. Never invent or retrieve stored text, fill sensitive fields, send or submit; existing intent and tool checks must all pass. Verify the returned field state before continuing.";
    case "activate_resolved_target": return "Only when the current task authorizes activation, activate its freshly resolved unique target through the existing guarded tap tool and inspect the returned observation. Never infer authorization for sending, payment, deletion or submission; stop on unknown prior effects.";
    case "scroll_resolved_container": return `If needed for the current task, scroll the freshly resolved unique observed container ${operation.direction} once through the existing guarded scroll tool, then reselect from its returned observation. Stop if the context changed or the prior effect is unknown.`;
    case "verify_effect": return `Verify the prior action using ${({ current_observation: "the latest observation", focused_input: "the observed input focus", target_state: "the currently observed target state" })[operation.evidence]}. Acceptance alone is not success; if effect is unknown, stop rather than replay the mutation.`;
    case "discard_stale_target": return "Discard the old target reference. Re-resolve only the same user intent from current evidence; a changed recipient or session requires stopping.";
  }
}
/** Branches are resolved against a frozen set of host-produced facts. A program
 * cannot observe future facts or cause the controller to execute operations. */
export function compileSkill(input: SkillSpec, inputFacts: SkillFacts): string[] {
  const spec = SkillSpecSchema.parse(input), facts = SkillFactsSchema.parse(inputFacts);
  if (!spec.entryConditions.every(p => predicateMatches(p, facts))) return [];
  const advice = ["Validated procedural hint only: base policy, user intent, current evidence and existing tool guards take precedence. Re-check evidence after each action; stop on context changes, protection, cancellation, ambiguity or an unknown dispatched effect."];
  let index = 0;
  for (let budget = 0; budget < spec.program.nodes.length; budget++) {
    const node = spec.program.nodes[index]!;
    if (node.kind === "end") { advice.push(node.outcome === "stop" ? "Stop this recovery attempt and report the observed limitation." : "Continue the user's task only from verified current evidence, using the normal guarded tools."); break; }
    if (node.kind === "branch") index = predicateMatches(node.condition, facts) ? node.yes : node.no;
    else { advice.push(operationText(node.operation)); index = node.next; }
  }
  return advice;
}
