import { createHash } from "node:crypto";
import type { DiagnosticEvent } from "../diagnostics/schema.js";
import { deepFreeze } from "../learning/schema.js";
import { compileSkill, matchesScope, matchesSkill, SKILL_POLICY_REVISION, skillHash, SkillScopeSchema, SkillSpecSchema, type SkillScope, type SkillSpec } from "./schema.js";
import { compactTrace, createEpisode, factsFromTrace, type FailureEpisode, type TraceStep } from "./trace.js";

export type SkillRuntimeOptions = {
  skillSnapshot?: readonly SkillSpec[];
  onSkillTrace?: (step: TraceStep) => void | Promise<void>;
  onSkillUsed?: (hashes: readonly string[]) => void | Promise<void>;
  onFailureEpisode?: (episode: FailureEpisode) => void | Promise<void>;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function contextDigest(value: unknown): string | undefined {
  if (!object(value) || typeof value.packageName !== "string" || !value.packageName || !Number.isSafeInteger(value.windowId)) return;
  let session = typeof value.sessionId === "string" ? value.sessionId : undefined;
  if (typeof value.snapshotId === "string") {
    const separator = value.snapshotId.lastIndexOf(":");
    if (separator > 0 && separator < value.snapshotId.length - 1) session = value.snapshotId.slice(0, separator);
  }
  if (!session) return;
  // Context evidence is retained only in memory, across invalidated snapshots;
  // no UI strings or target contents are hashed or persisted here.
  return createHash("sha256").update(JSON.stringify([session, value.packageName, value.windowId])).digest("hex");
}
function observe<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): void {
  try { void Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Learning cannot alter the phone run. */ }
}

/** A frozen, per-task view of tested procedures. One failed action may retain
 * its raw before-state in memory until the immediately following refresh. No
 * raw UI survives another action/decision or enters callbacks or episodes. */
export class SkillSession {
  private readonly scope?: SkillScope;
  private readonly snapshot: readonly SkillSpec[];
  private readonly steps: TraceStep[] = [];
  private readonly used = new Set<string>();
  private pending?: { step: TraceStep; scope: SkillScope; context: string };
  private failure?: { step: TraceStep; scope: SkillScope };
  private pendingRefresh?: { index: number; before: unknown; targetNodeId: unknown; diagnostic: DiagnosticEvent; context: string };
  private index = 0;
  constructor(private readonly options: SkillRuntimeOptions, hostVersion: string | undefined, modelProfile: string | undefined) {
    const scope = SkillScopeSchema.safeParse({ hostVersion, modelProfile, policyRevision: SKILL_POLICY_REVISION });
    this.scope = scope.success ? scope.data : undefined;
    this.snapshot = deepFreeze((options.skillSnapshot ?? []).slice(0, 64).flatMap(input => {
      const parsed = SkillSpecSchema.safeParse(input);
      return parsed.success && this.scope && parsed.data.expiresAt > Date.now() &&
        matchesScope({ ...parsed.data.scope, appDigest: undefined }, this.scope) ? [parsed.data] : [];
    }));
  }
  record(event: DiagnosticEvent | undefined, before?: unknown, after?: unknown, targetNodeId?: unknown): void {
    const refresh = this.pendingRefresh;
    this.pendingRefresh = undefined;
    if (!event || !this.scope) return;
    try {
      const step = compactTrace({ index: this.index++, before, after, targetNodeId, diagnostic: event });
      this.steps.push(step);
      if (this.steps.length > 24) this.steps.shift();
      observe(this.options.onSkillTrace, structuredClone(step));
      if (refresh && step.actionKind === "get_ui_tree" && event.outcome === "success" && step.errorCode === "NONE" &&
          step.after.complete === "yes" && contextDigest(after) === refresh.context) {
        // Only this adjacent successful refresh can complete the failed
        // action's structural evidence. Its original dispatch/acceptance facts
        // remain untouched: changed bounds are not proof of non-execution.
        const recovered = compactTrace({ index: refresh.index, before: refresh.before, after, targetNodeId: refresh.targetNodeId, diagnostic: refresh.diagnostic });
        const index = this.steps.findIndex(item => item.index === refresh.index);
        if (index >= 0) this.steps[index] = recovered;
        if (this.failure?.step.index === refresh.index) this.failure = { ...this.failure, step: recovered };
        if (this.pending?.step.index === refresh.index) this.pending = { ...this.pending, step: recovered };
      }
      if (step.errorCode !== "NONE" && step.errorCode !== "CANCELLED") {
        const packageName = object(before) ? before.packageName : object(after) ? after.packageName : undefined;
        const scope = { ...this.scope, ...(typeof packageName === "string" && packageName ? {
          appDigest: createHash("sha256").update(packageName).digest("hex"),
        } : {}) };
        this.failure = { step, scope };
        const beforeContext = contextDigest(before), afterContext = contextDigest(after);
        // A failure can carry a newly changed page. Its existence does not
        // justify applying a recovery learned for the previous page.
        this.pending = beforeContext && (!afterContext || beforeContext === afterContext) && step.changes.context !== "yes"
          ? { step, scope, context: beforeContext } : undefined;
        if (beforeContext && step.before.hasObservation && !step.after.hasObservation) {
          this.pendingRefresh = { index: step.index, before, targetNodeId, diagnostic: event, context: beforeContext };
        }
      } else if (this.pending && step.after.hasObservation && step.actionKind !== "tap_element" && step.actionKind !== "click_element" && step.actionKind !== "input_text" && step.actionKind !== "scroll" && step.actionKind !== "swipe") {
        // An automatic refresh supplies facts for the next decision; it cannot
        // prove that the preceding refused action succeeded.
        // An automatic read in a different app/window is not the context in
        // which this recovery was learned. Do not inject its old-app procedure.
        this.pending = contextDigest(after) !== this.pending.context ? undefined : { ...this.pending, step: { ...this.pending.step, after: step.after } };
      }
    } catch { /* Invalid optional learning data never interrupts execution. */ }
  }
  consumeHints(): string[] {
    this.pendingRefresh = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return [];
    const facts = factsFromTrace(pending.step);
    const skill = this.snapshot.find(spec => (this.used.size < 3 || this.used.has(skillHash(spec))) && matchesScope(spec.scope, pending.scope) && matchesSkill(spec, pending.step, facts));
    if (!skill) return [];
    const hash = skillHash(skill);
    this.used.add(hash);
    observe(this.options.onSkillUsed, Object.freeze([hash]));
    return compileSkill(skill, facts);
  }
  finish(termination: FailureEpisode["termination"]): void {
    this.pendingRefresh = undefined;
    if (!this.failure || termination === "cancelled") return;
    const { step, scope } = this.failure;
    if (!this.steps.some(item => item.index === step.index)) return;
    try {
      const episode = createEpisode({ scope, trigger: { errorCode: step.errorCode, reason: step.reason, actionKind: step.actionKind },
        steps: this.steps, termination, appliedSkillHashes: [...this.used].slice(0, 3) });
      observe(this.options.onFailureEpisode, episode);
    } catch { /* Persistence/observers cannot change the task result. */ }
  }
}
