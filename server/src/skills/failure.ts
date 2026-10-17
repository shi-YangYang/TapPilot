import { z } from "zod";

/** Closed diagnostic vocabulary: no endpoint, provider response, task or UI text. */
export const SkillFailureCodeSchema = z.enum([
  "MODEL_TIMEOUT", "MODEL_CONNECTION_FAILED", "MODEL_HTTP_ERROR", "MODEL_INVALID_RESPONSE",
  "MODEL_RESPONSE_LIMIT", "MODEL_OUTPUT_LIMIT", "MODEL_INVALID_TOOL_CALL", "MODEL_EMPTY_RESPONSE",
  "CONTEXT_LIMIT", "INVALID_MODEL_CONFIG", "INVALID_MODEL_URL",
  "SKILL_GENERATION_FAILED", "SKILL_GENERATION_CANCELLED", "SKILL_INVALID_PROPOSAL",
  "SKILL_INVALID_EPISODE", "SKILL_INVALID_MODEL", "SKILL_MODEL_SCOPE_MISMATCH", "SKILL_INVALID_PARENT",
  "SKILL_PARENT_SCOPE_MISMATCH", "SKILL_INVALID_FEEDBACK", "SKILL_FEEDBACK_PARENT_MISMATCH",
  "SKILL_INVALID_TIME", "SKILL_UNCHANGED_PROPOSAL",
  "SKILLS_SCOPE_MISMATCH", "SKILLS_UNREPRODUCIBLE", "SKILLS_INVALID_BUDGET", "SKILLS_EVALUATION_BUDGET",
  "SKILLS_REGRESSION", "SKILLS_NOT_APPLIED", "SKILLS_NO_IMPROVEMENT", "SKILLS_EVALUATION_FAILED",
  "SKILLS_ANDROID_REQUIRED", "SKILLS_ANDROID_UNAVAILABLE", "SKILLS_ANDROID_UNSUPPORTED", "SKILLS_ANDROID_BUSY",
  "SKILLS_ANDROID_ENVIRONMENT", "SKILLS_ANDROID_NO_IMPROVEMENT", "SKILLS_ANDROID_REGRESSION", "SKILLS_ANDROID_NOT_APPLIED",
  "SKILLS_ANDROID_UNREPRODUCIBLE", "SKILLS_ANDROID_BUDGET",
  "SKILLS_DUPLICATE_CANDIDATE", "SKILLS_INVALID_CANDIDATE", "SKILLS_UNKNOWN_PARENT",
  "SKILLS_NOT_CANDIDATE", "SKILLS_INCUMBENT_CHANGED", "SKILLS_UNTRUSTED_RECEIPT", "SKILLS_ADOPTION_FAILED",
  "SKILLS_BUDGET_EXHAUSTED", "SKILLS_STORE_LIMIT", "SKILLS_STORAGE_UNAVAILABLE", "SKILLS_JOB_FAILED",
  "SKILLS_CANCELLED", "SKILLS_JOB_CANCELLED", "SKILLS_INTERRUPTED", "SKILLS_JOB_TIMEOUT",
]);
export const SkillFailureStageSchema = z.enum(["generation", "evaluation", "adoption", "lifecycle"]);
export const SkillFailureSchema = z.object({
  stage: SkillFailureStageSchema,
  code: SkillFailureCodeSchema,
  httpStatus: z.number().int().min(100).max(599).optional(),
}).strict().refine(value => value.code === "MODEL_HTTP_ERROR" || value.httpStatus === undefined,
  { message: "invalid_http_failure" });
export type SkillFailure = z.infer<typeof SkillFailureSchema>;
export type SkillFailureStage = z.infer<typeof SkillFailureStageSchema>;

export function safeSkillFailure(error: unknown, stage: SkillFailureStage): SkillFailure {
  const raw = error instanceof Error ? "code" in error && typeof error.code === "string" ? error.code : error.message : "";
  const http = /^MODEL_HTTP_([1-5]\d\d)$/.exec(raw);
  if (http) return { stage, code: "MODEL_HTTP_ERROR", httpStatus: Number(http[1]) };
  const code = SkillFailureCodeSchema.safeParse(raw);
  if (code.success) return { stage, code: code.data };
  return { stage, code: stage === "generation" ? "SKILL_GENERATION_FAILED" : stage === "evaluation" ? "SKILLS_EVALUATION_FAILED"
    : stage === "adoption" ? "SKILLS_ADOPTION_FAILED" : "SKILLS_JOB_FAILED" };
}

/** Accept only a known runtime error prefix, never retain its message body. */
export function skillModelFailureCode(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const code = value.split(":", 1)[0]!;
  if (/^MODEL_HTTP_[1-5]\d{2}$/.test(code)) return code;
  if ((code.startsWith("MODEL_") || ["CONTEXT_LIMIT", "INVALID_MODEL_CONFIG", "INVALID_MODEL_URL"].includes(code))
    && SkillFailureCodeSchema.safeParse(code).success) return code;
}
