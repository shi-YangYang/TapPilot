import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { ContextChangeSchema, DiagnosticEventSchema, safeContextChange, safeDiagnosticActionKind, safeDiagnosticErrorCode, safeDiagnosticReason, type DiagnosticEvent } from "../diagnostics/schema.js";
import { EvidenceFlagSchema, ObservationFactsSchema, SkillScopeSchema, SkillTriggerSchema, SkillHashSchema, TargetFactsSchema, type ObservationFacts, type SkillFacts, type TargetFacts } from "./schema.js";

export const TraceStepSchema = z.object({
  index: z.number().int().min(0).max(100_000), actionKind: DiagnosticEventSchema.shape.actionKind,
  errorCode: DiagnosticEventSchema.shape.errorCode, reason: DiagnosticEventSchema.shape.reason,
  dispatchState: DiagnosticEventSchema.shape.dispatchState, acceptanceState: DiagnosticEventSchema.shape.acceptanceState,
  effectState: DiagnosticEventSchema.shape.effectState,
  executor: z.literal("node-v1").optional(),
  contextChange: ContextChangeSchema.optional(),
  contextConflictCount: DiagnosticEventSchema.shape.contextConflictCount,
  before: ObservationFactsSchema, after: ObservationFactsSchema, target: TargetFactsSchema,
  changes: z.object({ structure: EvidenceFlagSchema, context: EvidenceFlagSchema, focus: EvidenceFlagSchema, ime: EvidenceFlagSchema,
    targetBounds: EvidenceFlagSchema.optional(), targetIdentity: EvidenceFlagSchema.optional() }).strict(),
}).strict();
export type TraceStep = z.infer<typeof TraceStepSchema>;
export const FailureEpisodeSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), createdAt: z.number().int().min(0).max(8_640_000_000_000_000),
  scope: SkillScopeSchema, trigger: SkillTriggerSchema, steps: z.array(TraceStepSchema).min(1).max(24),
  termination: z.enum(["failed", "cancelled", "completed", "unknown"]), appliedSkillHashes: z.array(SkillHashSchema).max(3),
}).strict().superRefine((episode, context) => {
  if (!episode.steps.some(step => step.errorCode === episode.trigger.errorCode && step.reason === episode.trigger.reason && step.actionKind === episode.trigger.actionKind && step.errorCode !== "NONE")) context.addIssue({ code: z.ZodIssueCode.custom, message: "trigger_evidence_missing" });
  for (let i = 1; i < episode.steps.length; i++) if (episode.steps[i]!.index <= episode.steps[i - 1]!.index) context.addIssue({ code: z.ZodIssueCode.custom, message: "non_monotonic_steps" });
});
export type FailureEpisode = z.infer<typeof FailureEpisodeSchema>;
export type FailureTrace = FailureEpisode;
export const FailureTraceSchema = FailureEpisodeSchema;
const object = (input: unknown): input is Record<string, unknown> => Boolean(input) && typeof input === "object" && !Array.isArray(input);
const flag = (value: unknown): "yes" | "no" | "unknown" => value === true ? "yes" : value === false ? "no" : "unknown";
function nodes(input: unknown): Record<string, unknown>[] {
  return object(input) && Array.isArray(input.nodes) ? input.nodes.slice(0, 10_000).filter(object) : [];
}
/** This is the only boundary accepting raw observations. It projects booleans
 * and counts explicitly; text, IDs, coordinates and package names never escape. */
export function compactObservation(input: unknown): ObservationFacts {
  const observed = object(input) && Array.isArray(input.nodes), source = nodes(input);
  const count = (key: string) => source.filter(node => node[key] === true).length;
  const focus = source.some(node => node.focused === true) ? "yes" : observed && input.truncated === false ? "no" : "unknown";
  const changed = object(input) ? input.changedLabelNodeIds : undefined;
  const labelsKnown = observed && typeof input.snapshotId === "string" && !!input.snapshotId && input.truncated === false &&
    Array.isArray(input.nodes) && input.nodes.length <= 10_000 && Array.isArray(changed) && changed.length >= 1 && changed.length <= 8 &&
    changed.every(id => typeof id === "string" && !!id && source.filter(node => node.nodeId === id).length === 1) && new Set(changed).size === changed.length;
  return ObservationFactsSchema.parse({ hasObservation: observed, complete: observed ? flag(input.truncated === false ? true : input.truncated === true ? false : undefined) : "unknown",
    nodeCount: source.length, actionableCount: source.filter(node => node.clickable === true || node.editable === true || node.scrollable === true).length,
    editableCount: count("editable"), scrollableCount: count("scrollable"), focusedCount: count("focused"),
    focusPresent: focus, imeVisible: object(input) ? flag(input.imeVisible ?? input.keyboardVisible) : "unknown",
    changedLabelsPresent: labelsKnown ? "yes" : "unknown", changedLabelCount: labelsKnown ? changed.length : 0 });
}
function targetFacts(input: unknown, targetNodeId: unknown): TargetFacts {
  const source = nodes(input), target = typeof targetNodeId === "string" ? source.find(node => node.nodeId === targetNodeId) : undefined;
  const missing = { present: "unknown", clickable: "unknown", editable: "unknown", scrollable: "unknown", ancestorClickable: "unknown", visible: "unknown", enabled: "unknown", focused: "unknown" } as const;
  if (!target) return { ...missing, present: typeof targetNodeId === "string" && object(input) && input.truncated === false ? "no" : "unknown" };
  const seen = new Set<unknown>([target.nodeId]);
  let parentId = target.parentId, ancestor: TargetFacts["ancestorClickable"] = "no";
  for (let depth = 0; parentId != null && depth < 64; depth++) {
    if (seen.has(parentId)) { ancestor = "unknown"; break; }
    seen.add(parentId);
    const parent = source.find(node => node.nodeId === parentId);
    if (!parent) { ancestor = "unknown"; break; }
    if (parent.clickable === true) { ancestor = "yes"; break; }
    parentId = parent.parentId;
    if (depth === 63 && parentId != null) ancestor = "unknown";
  }
  // In full native snapshots omitted capability booleans mean false, while
  // visibility/enabled omissions still carry no affirmative evidence.
  return { present: "yes", clickable: flag(target.clickable === true), editable: flag(target.editable === true), scrollable: flag(target.scrollable === true), ancestorClickable: ancestor, visible: flag(target.visible), enabled: flag(target.enabled), focused: flag(target.focused) };
}
function compareField(before: unknown, after: unknown, key: string): "yes" | "no" | "unknown" {
  return object(before) && object(after) && before[key] != null && after[key] != null ? flag(before[key] !== after[key]) : "unknown";
}
function session(input: unknown): string | undefined {
  if (!object(input)) return;
  if (typeof input.snapshotId === "string") {
    const separator = input.snapshotId.lastIndexOf(":");
    if (separator > 0 && separator < input.snapshotId.length - 1) return input.snapshotId.slice(0, separator);
  }
  if (typeof input.sessionId === "string" && input.sessionId) return input.sessionId;
}
function compareTarget(before: unknown, after: unknown, targetNodeId: unknown, contextChanged: string): { targetBounds: "yes" | "no" | "unknown"; targetIdentity: "yes" | "no" | "unknown" } {
  const unknown = { targetBounds: "unknown", targetIdentity: "unknown" } as const;
  if (contextChanged !== "no" || typeof targetNodeId !== "string") return unknown;
  const old = nodes(before).find(node => node.nodeId === targetNodeId);
  if (!old) return unknown;
  const currentNodes = nodes(after);
  let current = currentNodes.find(node => node.nodeId === targetNodeId);
  // A single stable resource identifier and class can corroborate a refreshed
  // handle for diagnostic comparison only. This never authorizes an action.
  if (!current && typeof old.resourceId === "string" && old.resourceId) {
    const priorMatches = nodes(before).filter(node => node.resourceId === old.resourceId && node.className === old.className);
    const matches = currentNodes.filter(node => node.resourceId === old.resourceId && node.className === old.className);
    if (priorMatches.length === 1 && matches.length === 1) current = matches[0];
  }
  if (!current) return unknown;
  const rect = (value: unknown): value is number[] => Array.isArray(value) && value.length === 4 && value.every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate));
  const identityKeys = ["className", "resourceId", "text", "contentDescription"];
  const comparableIdentity = identityKeys.some(key => typeof old[key] === "string" || typeof current![key] === "string");
  const oldBounds = old.bounds, newBounds = current.bounds;
  return { targetBounds: rect(oldBounds) && rect(newBounds) ? flag(oldBounds.some((coordinate, index) => coordinate !== newBounds[index])) : "unknown",
    targetIdentity: comparableIdentity ? flag(identityKeys.some(key => (typeof old[key] === "string" ? old[key] : "") !== (typeof current![key] === "string" ? current![key] : ""))) : "unknown" };
}
/** Raw structural signatures are transient. They do not include strings or
 * bounds and are never persisted, returned, or included in model input. */
function topology(input: unknown): unknown {
  const source = nodes(input), indexes = new Map(source.map((node, index) => [node.nodeId, index]));
  return source.map(node => [indexes.get(node.parentId) ?? -1, node.clickable === true, node.editable === true, node.scrollable === true, node.focused === true, flag(node.enabled), flag(node.visible)]);
}
export function compactTrace(input: { index: number; before?: unknown; after?: unknown; actionKind?: unknown; targetNodeId?: unknown; diagnostic: Pick<DiagnosticEvent, "actionKind" | "errorCode" | "reason" | "dispatchState" | "acceptanceState" | "effectState" | "contextChange" | "contextConflictCount"> & { executor?: "node-v1" } }): TraceStep {
  const before = compactObservation(input.before), after = compactObservation(input.after);
  const beforeSession = session(input.before), afterSession = session(input.after);
  const contextFlags = [beforeSession && afterSession ? flag(beforeSession !== afterSession) : "unknown", ...["packageName", "windowId"].map(key => compareField(input.before, input.after, key))];
  const context = contextFlags.includes("yes") ? "yes" : contextFlags.every(value => value === "no") ? "no" : "unknown";
  const comparable = before.hasObservation && after.hasObservation;
  const contextChange = safeContextChange(input.diagnostic.contextChange);
  return TraceStepSchema.parse({ index: input.index, actionKind: safeDiagnosticActionKind(input.actionKind ?? input.diagnostic.actionKind), errorCode: safeDiagnosticErrorCode(input.diagnostic.errorCode), reason: safeDiagnosticReason(input.diagnostic.reason),
    dispatchState: input.diagnostic.dispatchState, acceptanceState: input.diagnostic.acceptanceState, effectState: input.diagnostic.effectState,
    ...(input.diagnostic.executor === "node-v1" ? { executor: "node-v1" } : {}),
    ...(contextChange ? { contextChange } : {}),
    ...(input.diagnostic.contextConflictCount !== undefined ? { contextConflictCount: input.diagnostic.contextConflictCount } : {}),
    before, after, target: targetFacts(input.before, input.targetNodeId), changes: {
      structure: comparable ? flag(JSON.stringify(topology(input.before)) !== JSON.stringify(topology(input.after))) : "unknown",
      context, focus: comparable && before.focusPresent !== "unknown" && after.focusPresent !== "unknown" ? flag(before.focusedCount !== after.focusedCount || before.focusPresent !== after.focusPresent) : "unknown",
      ime: before.imeVisible !== "unknown" && after.imeVisible !== "unknown" ? flag(before.imeVisible !== after.imeVisible) : "unknown",
      ...compareTarget(input.before, input.after, input.targetNodeId, context),
    } });
}
export function factsFromTrace(input: TraceStep): SkillFacts {
  const step = TraceStepSchema.parse(input);
  const native = step.executor === "node-v1" && step.errorCode === "TARGET_CHANGED" && step.reason === "PAGE_CONTEXT_CHANGED" &&
    step.dispatchState === "not_sent" && step.acceptanceState === "rejected" && Boolean(step.contextChange);
  const labelsOnly = native && step.contextChange?.kind === "content" &&
    (step.contextChange.region === "outside_target" || step.contextChange.region === "peer_item") &&
    step.contextChange.targetMatched && step.contextChange.actionTargetMatched &&
    step.after.changedLabelsPresent === "yes" && step.contextChange.changedNodes === step.after.changedLabelCount;
  return { ...step.after, structureChanged: step.changes.structure, contextChanged: step.changes.context, focusChanged: step.changes.focus, imeChanged: step.changes.ime,
    nativeContextChange: native ? "yes" : "unknown", labelOnlyContextChange: native ? flag(labelsOnly) : "unknown",
    priorActionAccepted: step.acceptanceState === "accepted" ? "yes" : step.acceptanceState === "rejected" ? "no" : "unknown",
    priorEffectUnknown: step.effectState === "unknown" && step.dispatchState !== "not_sent" && step.dispatchState !== "not_applicable" ? "yes" : step.effectState === "unknown" ? "unknown" : "no",
    targetPresent: step.target.present, targetClickable: step.target.clickable, targetEditable: step.target.editable, targetScrollable: step.target.scrollable,
    targetAncestorClickable: step.target.ancestorClickable, targetVisible: step.target.visible, targetEnabled: step.target.enabled, targetFocused: step.target.focused };
}
export function episodeFingerprint(input: FailureEpisode): string {
  const episode = FailureEpisodeSchema.parse(input);
  return createHash("sha256").update(JSON.stringify({ scope: episode.scope, trigger: episode.trigger, steps: episode.steps.map(({ index: _index, ...step }) => step), termination: episode.termination })).digest("hex");
}
export function createEpisode(input: Omit<FailureEpisode, "schemaVersion" | "id" | "createdAt">, now = Date.now()): FailureEpisode {
  return FailureEpisodeSchema.parse({ schemaVersion: 1, id: randomUUID(), createdAt: now, ...input });
}
