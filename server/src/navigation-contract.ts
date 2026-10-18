import { z } from "zod";

export const navigationStopReasonSchema = z.enum(["target_found", "target_candidate", "already_explored", "max_steps", "no_progress", "scope_changed", "observation_unavailable",
  "target_ambiguous", "target_blocked", "container_unavailable", "action_failed", "cancelled", "timeout"]);

/** Bounded navigation reports observed progress, never completion of the user's task. */
export const navigationResultSchema = z.object({
  completedSteps: z.number().int().min(0).max(4),
  stopReason: navigationStopReasonSchema,
  targetFound: z.boolean(),
  candidateNodeIds: z.array(z.string().min(1).max(64)).min(1).max(8).refine(ids => new Set(ids).size === ids.length).optional(),
  uncertainStep: z.boolean().optional(),
  error: z.object({ code: z.string().min(1).max(100), message: z.string().max(1000), retryable: z.boolean() }).strict().optional(),
}).strict().refine(value => value.targetFound === (value.stopReason === "target_found"),
  "Only a uniquely observed target can report targetFound.")
  .refine(value => (value.stopReason === "target_candidate") === (value.candidateNodeIds !== undefined),
    "Only a candidate stop carries candidate handles from its current observation.");
