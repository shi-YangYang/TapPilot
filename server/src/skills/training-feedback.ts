import { z } from "zod";
import { SkillHashSchema } from "./schema.js";

const count = z.number().int().min(0).max(1_000_000);
export const SkillTrainingCaseFactsSchema = z.object({
  success: z.boolean(), unsafe: z.boolean(), falseCompletion: z.boolean(),
  applications: count, requests: count, contextRefusals: count,
}).strict();

/** Training pairs from the current evaluator, never holdout/safety cases or
 * source-report claims. These counts inform a hypothesis; they are not an
 * evaluation receipt and cannot authorize adoption or phone operations. */
export const SkillTrainingFeedbackSchema = z.object({
  skillHash: SkillHashSchema,
  reason: z.enum(["no_improvement", "regression", "not_applied"]),
  pairs: z.array(z.object({ baseline: SkillTrainingCaseFactsSchema, candidate: SkillTrainingCaseFactsSchema }).strict()).min(1).max(3),
}).strict();
export type SkillTrainingCaseFacts = z.infer<typeof SkillTrainingCaseFactsSchema>;
export type SkillTrainingFeedback = z.infer<typeof SkillTrainingFeedbackSchema>;
