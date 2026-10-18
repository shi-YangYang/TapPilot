import { z } from "zod";

/** Observation quality is separate from structural truncation and action success. */
export const observationQualitySchema = z.object({
  status: z.enum(["usable", "limited", "unavailable"]),
  reason: z.enum(["accessible_content", "incomplete_tree", "no_accessible_content"]),
  actionableCount: z.number().int().min(0).max(500),
  readableCount: z.number().int().min(0).max(500),
}).strict();

export const executionEvidenceSchema = z.object({
  dispatch: z.literal("sent"), acceptance: z.literal("accepted"),
  effect: z.enum(["changed", "unchanged", "unknown"]),
  verification: z.enum(["unverified", "verified"]),
  verificationScope: z.enum(["input_value", "checked_state"]).optional(),
}).strict().refine(value => value.verification === "verified"
  ? value.verificationScope !== undefined : value.verificationScope === undefined,
"Verified execution must identify its local verification scope; unverified execution cannot claim one.");

export const observationCapabilitiesSchema = z.object({
  readinessWait: z.literal(true).optional(),
  actionSelectorWait: z.literal(true).optional(),
  windowReadiness: z.literal(true).optional(),
}).strict();

/** Startup observation evidence, not a guarantee that app data has finished loading. */
export const windowReadinessSchema = z.object({
  status: z.enum(["ready", "settling"]),
  reason: z.enum(["interaction_stable", "known_window", "deadline"]),
  samples: z.number().int().min(0).max(1000),
  waitedMs: z.number().int().min(0).max(60_000),
}).strict().refine(value => (value.status === "settling") === (value.reason === "deadline"),
"Startup readiness status and reason must agree.");

export const observationWaitSchema = z.object({
  mode: z.enum(["semantic", "events"]),
  status: z.enum(["changed", "matched", "timed_out", "window_changed"]),
  semanticChanged: z.boolean().nullable(),
  requireUsable: z.boolean().optional(),
  ready: z.boolean().optional(),
}).strict();

export const actionObservationWaitSchema = z.object({
  status: z.enum(["matched", "ready", "timed_out"]),
  ready: z.boolean(),
}).strict().refine(value => value.ready === (value.status !== "timed_out"), "Wait status and readiness must agree.");

export function isSemanticObservation(value: Record<string, unknown> | undefined): boolean {
  return value?.observationContract === "semantic-v1" && typeof value.snapshotId === "string" && Array.isArray(value.nodes);
}

export function hasUnavailableObservation(value: Record<string, unknown> | undefined): boolean {
  return isSemanticObservation(value) && observationQualitySchema.safeParse(value?.quality).data?.status === "unavailable";
}

export function hasSettlingObservation(value: Record<string, unknown> | undefined): boolean {
  return isSemanticObservation(value) && windowReadinessSchema.safeParse(value?.readiness).data?.status === "settling";
}
