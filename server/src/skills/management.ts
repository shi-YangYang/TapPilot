import { z } from "zod";
import { SkillSpecSchema, type SkillSpec } from "./schema.js";
import type { SkillValidation } from "./evaluation.js";

/** Titles are local display metadata. They never enter a skill program or model prompt. */
export const ManagedSkillInputSchema = z.object({
  title: z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  spec: SkillSpecSchema,
}).strict();
export type ManagedSkillInput = { title: string; spec: SkillSpec };
export type ManagedSkill = {
  id: string; title: string; source: "manual" | "automatic";
  state: "draft" | "candidate" | "active" | "superseded" | "revoked" | "rejected";
  spec: SkillSpec; createdAt: number; updatedAt: number;
  successes: number; failures: number; validation?: SkillValidation;
};
