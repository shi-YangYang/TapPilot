import { createHash } from "node:crypto";
import type { DiagnosticEvent } from "../diagnostics/schema.js";
import { deepFreeze } from "../learning/schema.js";
import { compileSkill, compilePreventiveSkill, matchesScope, matchesSkill, SKILL_POLICY_REVISION, skillHash, SkillScopeSchema, SkillSpecSchema, SkillFactsSchema, type SkillScope, type SkillSpec } from "./schema.js";
import { compactObservation, compactTrace, createEpisode, factsFromTrace, type FailureEpisode, type TraceStep } from "./trace.js";
import { observedLabelChanges } from "./label-observation.js";

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
const mutations = new Set(["tap_element", "click_element", "input_text", "scroll", "swipe", "press_key", "open_settings"]);

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
  private preventionBaseline?: { snapshotId: string; context: string };
  private preventionLatestSnapshotId?: string;
  private preventionReads = 0;
  private preventionRequested = false;
  private preventionClosed = false;
  private preventiveHint?: { spec: SkillSpec; advice: string[] };
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
  private scopedObservation(value: unknown): SkillScope | undefined {
    if (!this.scope || !object(value) || typeof value.packageName !== "string" || !value.packageName || !contextDigest(value)) return;
    return { ...this.scope, appDigest: createHash("sha256").update(value.packageName).digest("hex") };
  }
  /** One comparison window after the initial read or a successful mutation's
   * complete current observation. Presence does not satisfy skill conditions. */
  hasPreventiveCandidate(observation: unknown): boolean {
    if (this.preventionClosed || this.preventionRequested || this.preventionReads !== 1 || !this.preventionBaseline
      || !object(observation) || observation.snapshotId !== this.preventionBaseline.snapshotId || contextDigest(observation) !== this.preventionBaseline.context) return false;
    const scope = this.scopedObservation(observation);
    const eligible = Boolean(scope && this.snapshot.some(spec => spec.prevention && spec.expiresAt > Date.now() && matchesScope(spec.scope, scope)
      && (this.used.size < 3 || this.used.has(skillHash(spec)))));
    this.preventionRequested = eligible;
    if (!eligible) this.preventionClosed = true;
    return eligible;
  }
  /** Ordinary successful reads provide physical facts; no rejection, target,
   * execution result or semantic permission is invented for a preventive hint. */
  preparePrevention(before: unknown, after: unknown): boolean {
    if (this.preventionClosed || !this.preventionRequested || this.preventionReads !== 2 || !this.preventionBaseline
      || !object(before) || before.snapshotId !== this.preventionBaseline.snapshotId || contextDigest(before) !== this.preventionBaseline.context
      || !object(after) || after.snapshotId !== this.preventionLatestSnapshotId) return false;
    this.preventionClosed = true;
    const changed = observedLabelChanges(before, after), scope = this.scopedObservation(after);
    if (!changed || !scope || !object(after)) return false;
    const facts = SkillFactsSchema.parse({ ...compactObservation({ ...after, changedLabelNodeIds: changed }),
      observedLabelChanges: "yes", structureChanged: "no", contextChanged: "no", focusChanged: "no", imeChanged: "unknown",
      priorActionAccepted: "unknown", priorEffectUnknown: "unknown", nativeContextChange: "unknown", labelOnlyContextChange: "unknown",
      targetPresent: "unknown", targetClickable: "unknown", targetEditable: "unknown", targetScrollable: "unknown",
      targetAncestorClickable: "unknown", targetVisible: "unknown", targetEnabled: "unknown", targetFocused: "unknown" });
    for (const spec of this.snapshot) {
      if (!spec.prevention || spec.expiresAt <= Date.now() || !matchesScope(spec.scope, scope)
        || this.used.size >= 3 && !this.used.has(skillHash(spec))) continue;
      const advice = compilePreventiveSkill(spec, facts);
      if (advice.length) { this.preventiveHint = { spec, advice }; return true; }
    }
    return false;
  }
  record(event: DiagnosticEvent | undefined, before?: unknown, after?: unknown, targetNodeId?: unknown): void {
    const refresh = this.pendingRefresh;
    this.pendingRefresh = undefined;
    if (!event || !this.scope) return;
    try {
      const step = compactTrace({ index: this.index++, before, after, targetNodeId, diagnostic: event });
      // Any intervening tool after preparation invalidates its exact current
      // evidence. Before preparation, permit only the bounded read/wait/read.
      if (this.preventiveHint) this.preventiveHint = undefined;
      if (mutations.has(step.actionKind)) {
        this.preventionClosed = true;
        this.preventionRequested = false;
        this.preventionBaseline = undefined;
        this.preventionLatestSnapshotId = undefined;
        this.preventionReads = 0;
        const context = contextDigest(after);
        if (event.outcome === "success" && step.errorCode === "NONE" && step.dispatchState === "sent"
          && step.acceptanceState === "accepted" && ["changed", "unchanged"].includes(step.effectState)
          && step.before.complete === "yes" && step.after.complete === "yes" && context && context === contextDigest(before)
          && object(before) && object(after) && typeof after.snapshotId === "string" && after.snapshotId !== before.snapshotId) {
          // The mutation's after-state is the next baseline. Its input/text
          // changes are never mixed into the later passive-label comparison.
          this.preventionBaseline = { snapshotId: after.snapshotId, context };
          this.preventionLatestSnapshotId = after.snapshotId;
          this.preventionReads = 1;
          this.preventionClosed = false;
        }
      } else if (!this.preventionClosed) {
        const context = contextDigest(after);
        if (event.outcome !== "success" || step.errorCode !== "NONE" || !["get_ui_tree", "wait_for_ui_change"].includes(step.actionKind)
          || context && this.preventionBaseline && context !== this.preventionBaseline.context) this.preventionClosed = true;
        else if (step.actionKind === "get_ui_tree" || step.actionKind === "wait_for_ui_change" &&
            object(after) && after.observationContract === "semantic-v1" && Array.isArray(after.nodes)) {
          this.preventionReads++;
          if (step.after.complete !== "yes" || !context || !object(after) || typeof after.snapshotId !== "string"
            || this.preventionReads > 2 || this.preventionReads === 2 && !this.preventionRequested) this.preventionClosed = true;
          else {
            this.preventionLatestSnapshotId = after.snapshotId;
            if (!this.preventionBaseline) this.preventionBaseline = { snapshotId: after.snapshotId, context };
          }
        }
      }
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
    this.preventionClosed = true;
    const prepared = this.preventiveHint;
    this.preventiveHint = undefined;
    if (prepared && prepared.spec.expiresAt > Date.now()) {
      const hash = skillHash(prepared.spec);
      this.used.add(hash);
      observe(this.options.onSkillUsed, Object.freeze([hash]));
      return [...prepared.advice];
    }
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
    this.preventiveHint = undefined;
    this.preventionClosed = true;
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
