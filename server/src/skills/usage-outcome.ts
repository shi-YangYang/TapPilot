import { SkillHashSchema } from "./schema.js";
import type { TraceStep } from "./trace.js";

type UsageTrace = Pick<TraceStep, "actionKind" | "errorCode" | "reason" | "dispatchState" | "acceptanceState" | "effectState">;
export type SkillRunOutcome = {
  status: "completed" | "failed" | "cancelled";
  errorCode?: string;
  /** Must come from an independent business oracle, never a model declaration. */
  businessVerified?: boolean;
  unsafe?: boolean;
  falseCompletion?: boolean;
};
export type SkillUsageOutcome = {
  usedSkillHashes: string[];
  failedSkillHashes: string[];
  verifiedSkillHashes: string[];
};
const mutations = new Set(["tap_element", "click_element", "input_text", "scroll", "swipe", "press_key", "open_settings"]);
const safetyErrors = new Set(["PROTECTED_APP", "PASSWORD_FIELD_BLOCKED", "SENSITIVE_FIELD", "CONFIRMATION_REQUIRED",
  "DEVICE_LOCKED", "MANUAL_ACTION_REQUIRED", "WIRELESS_SESSION_CHANGED", "COMPLETION_CONTEXT_CHANGED"]);
const unsafeResults = new Set(["GESTURE_COMPLETION_TIMEOUT"]);
const invalidActionErrors = new Set(["INVALID_TOOL_ARGUMENTS", "MODEL_INVALID_TOOL_CALL", "UNKNOWN_TOOL", "UNOBSERVED_ACTION_BATCH"]);

/** A hint owns only its next mutation, not every later step of the task.
 * Reads may gather the evidence requested by a hint. A completed guarded
 * mutation consumes that attribution even if another unrelated action fails.
 * Safety incidents or an action with unknown dispatch/effect quarantine used
 * advice conservatively; this is suspension, not proof of semantic causality. */
export class SkillUsageTracker {
  private readonly used = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  onUsed(hashes: readonly string[]): void {
    for (const input of hashes) {
      const hash = SkillHashSchema.parse(input);
      this.used.add(hash); this.pending.add(hash);
    }
  }
  private quarantine(hashes: Iterable<string>): void { for (const hash of hashes) this.failed.add(hash); }
  onTrace(step: UsageTrace): void {
    if (safetyErrors.has(step.errorCode) || step.reason === "SENSITIVE_TARGET" || step.reason === "SESSION_CHANGED") {
      this.quarantine(this.used); this.pending.clear(); return;
    }
    if (!mutations.has(step.actionKind)) return;
    const unknown = step.dispatchState !== "not_sent" && (step.dispatchState === "unknown"
      || step.acceptanceState === "unknown" || step.effectState === "unknown");
    if (unknown) this.quarantine(this.used);
    else if (step.errorCode !== "NONE" && step.errorCode !== "CANCELLED") this.quarantine(this.pending);
    this.pending.clear();
  }
  finish(outcome: SkillRunOutcome): SkillUsageOutcome {
    const errorCode = outcome.errorCode?.split(":", 1)[0];
    if (outcome.unsafe || outcome.falseCompletion || errorCode && (safetyErrors.has(errorCode) || unsafeResults.has(errorCode)))
      this.quarantine(this.used);
    else if (outcome.status === "failed" && errorCode && invalidActionErrors.has(errorCode)) this.quarantine(this.pending);
    const verified = outcome.status === "completed" && outcome.businessVerified === true && !outcome.unsafe && !outcome.falseCompletion;
    return { usedSkillHashes: [...this.used], failedSkillHashes: [...this.failed],
      verifiedSkillHashes: verified ? [...this.used].filter(hash => !this.failed.has(hash)) : [] };
  }
}
