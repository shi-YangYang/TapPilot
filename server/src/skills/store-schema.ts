import { z } from "zod";
import { SkillSpecSchema, SkillFeedbackSchema, SkillHashSchema, skillHash } from "./schema.js";
import { FailureEpisodeSchema } from "./trace.js";
import { SkillValidationSchema } from "./evaluation.js";
import { SkillFailureSchema } from "./failure.js";

export const MAX_BYTES = 2 * 1024 * 1024;
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const counter = z.number().int().nonnegative().max(1_000_000);
export const JobSchema = z.object({
  id: z.string().uuid(), episodeId: z.string().uuid(), fingerprint: SkillHashSchema,
  state: z.enum(["queued", "running", "interrupted", "adopted", "rejected", "cancelled", "exhausted"]),
  createdAt: timestamp, startedAt: timestamp.optional(), finishedAt: timestamp.optional(),
  ownerPid: z.number().int().positive().optional(), candidateHashes: z.array(SkillHashSchema).max(2),
  feedback: z.array(SkillFeedbackSchema).max(2), modelCalls: counter, lastFailure: SkillFailureSchema.optional(),
}).strict();
export const RecordSchema = z.object({ spec: SkillSpecSchema, hash: SkillHashSchema,
  state: z.enum(["candidate", "active", "superseded", "revoked", "rejected"]),
  jobId: z.string().uuid(), createdAt: timestamp, successes: counter, failures: counter,
  validation: SkillValidationSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.hash !== skillHash(record.spec) || record.validation && record.validation.skillHash !== record.hash
    || ["active", "superseded"].includes(record.state) && !record.validation)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_skill_validation" });
});
export const StateSchema = z.object({ schemaVersion: z.literal(1), enabled: z.boolean(),
  episodes: z.array(FailureEpisodeSchema).max(64), jobs: z.array(JobSchema).max(64), skills: z.array(RecordSchema).max(128),
  daily: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), jobs: z.number().int().min(0).max(2),
    modelCalls: z.number().int().min(0).max(200) }).strict(),
}).strict();
export type StoreState = z.infer<typeof StateSchema>;
export type SkillJob = z.infer<typeof JobSchema>;
export type SkillRecord = z.infer<typeof RecordSchema>;
export const initialState = (): StoreState => ({ schemaVersion: 1, enabled: true, episodes: [], jobs: [], skills: [],
  daily: { day: new Date().toISOString().slice(0, 10), jobs: 0, modelCalls: 0 } });
