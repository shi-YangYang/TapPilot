import { createHash } from "node:crypto";
import type { Message } from "./model.js";
import { RuntimeError } from "./model.js";

type ActionOutcome = { action: string; accepted: true; observationChanged?: boolean };
type Entry = { message: Message; snapshot: boolean; actionOutcome?: ActionOutcome };
const OMIT_FROM_DIGEST = new Set(["snapshotId", "revision", "meta", "timings", "durationMs", "timestamp"]);
const ACTION_NAMES = new Set(["tap_element", "click_element", "input_text", "scroll", "swipe", "press_key", "open_settings"]);

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !OMIT_FROM_DIGEST.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  return value;
}

export function signature(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex");
}

function hasSnapshot(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (Array.isArray(value)) return value.some(item => hasSnapshot(item, depth + 1));
  const obj = value as Record<string, unknown>;
  return typeof obj.snapshotId === "string" || Object.values(obj).some(item => hasSnapshot(item, depth + 1));
}

export function fullObservation(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.snapshotId === "string" && Array.isArray(obj.nodes)) return obj;
  for (const item of Object.values(obj)) {
    const found = fullObservation(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function summary(value: unknown, actionOutcome?: ActionOutcome): string {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : {};
  return JSON.stringify({ ok: obj.ok !== false, ...(typeof error.code === "string" ? { error: { code: error.code } } : {}),
    ...(actionOutcome ? { hostAction: actionOutcome } : {}),
    superseded: true, note: "Earlier tool details removed. Only the latest observation may be used for node actions." });
}

/** Keep valid tool-call/result pairs, but never keep old full UI trees in subsequent requests. */
export class Conversation {
  private entries: Entry[];
  private latestSnapshotDigest = "";
  private pendingPointerAction: { action: "click_element" | "tap_element"; digest: string } | undefined;
  constructor(system: string, task: string) {
    this.entries = [{ message: { role: "system", content: system }, snapshot: false }, { message: { role: "user", content: task }, snapshot: false }];
  }
  assistant(message: Message): void { this.entries.push({ message, snapshot: false }); }
  result(id: string, value: Record<string, unknown>, invalidateSnapshot = false, actionName?: string): { stateChanged: boolean; observationChanged?: boolean } {
    const snapshot = hasSnapshot(value);
    let stateChanged = false;
    let observationChanged: boolean | undefined;
    let nextDigest: string | undefined;
    const observation = fullObservation(value);
    const completeObservation = observation?.truncated === false && Array.isArray(observation.nodes) && observation.nodes.length > 0;
    if (snapshot || invalidateSnapshot) {
      // Compare UI content itself, not an action/read wrapper or changing revision/timing fields.
      // A partial find_element result is not evidence that the screen changed.
      if (observation) {
        const digest = signature(observation);
        if (this.latestSnapshotDigest) observationChanged = digest !== this.latestSnapshotDigest;
        stateChanged = digest !== this.latestSnapshotDigest;
        nextDigest = digest;
      }
    }
    const result = value.result as Record<string, unknown> | undefined;
    const action = result?.action as Record<string, unknown> | undefined;
    const accepted = invalidateSnapshot && value.ok === true && action?.accepted === true;
    // actionName comes from the host's validated tool request, never from a phone/UI field.
    const actionOutcome: ActionOutcome | undefined = accepted && actionName && ACTION_NAMES.has(actionName) ? {
      action: actionName, accepted: true, ...(observationChanged !== undefined ? { observationChanged } : {}),
    } : undefined;
    let nextPendingPointerAction = this.pendingPointerAction;
    if (invalidateSnapshot) nextPendingPointerAction = (actionOutcome?.action === "click_element" || actionOutcome?.action === "tap_element") &&
      observationChanged === false && nextDigest !== undefined && completeObservation ? { action: actionOutcome.action, digest: nextDigest } : undefined;
    else if (stateChanged) nextPendingPointerAction = undefined;
    const pointerStillIneffective = !invalidateSnapshot && completeObservation && nextDigest !== undefined && nextDigest === nextPendingPointerAction?.digest;
    // Reserved host fields must be constructed here; untrusted tool content cannot supply guidance.
    const { hostGuidance: _untrustedGuidance, hostAction: _untrustedAction, ...toolValue } = value;
    const guidance = pointerStillIneffective && nextPendingPointerAction?.action === "tap_element" ? {
      code: "TOUCH_TAP_INEFFECTIVE",
      message: "The previous tap_element dispatched a real touch, but its immediate observation and this later full UI read are both unchanged. Stop attempting this target and explain the limitation. Do not repeat the tap or rename it to swipe to touch the same target again. Never bypass a protected or restricted action.",
    } : pointerStillIneffective ? {
      code: "NATIVE_CLICK_INEFFECTIVE",
      message: "The previous native click was accepted, but its immediate observation and this later full UI read are both unchanged. Do not repeat that native click. If the intended target is still unambiguous, you may try one tap_element using its snapshotId and nodeId from THIS latest observation, or explain that it cannot be operated. This dispatches a real touch; the host computes the location from the current node. Never bypass a protected or restricted action. If that touch also has no effect, stop and explain the limitation.",
    } : accepted && observationChanged === false ? {
      code: "OBSERVATION_UNCHANGED", message: "Android accepted the action, but the observed UI is unchanged. Acceptance does not prove the intended effect. Inspect the host's following fresh read or wait for the expected control before deciding again; an animation may still be running. Do not blindly repeat. A tap_element is already a real touch: do not replace it with a stationary swipe to repeat the same attempt. Never bypass a protected or restricted action.",
    } : undefined;
    const stored = { ...toolValue, ...(actionOutcome ? { hostAction: actionOutcome } : {}), ...(guidance ? { hostGuidance: guidance } : {}) };
    const content = JSON.stringify(stored);
    if (Buffer.byteLength(content) > 96 * 1024) throw new RuntimeError("TOOL_RESULT_LIMIT", "界面数据过大，请使用更小的 UI 树或控件查找。动作结果不会自动重试。");
    // Commit history and comparison state only after the entire stored result passes its limit.
    if (nextDigest !== undefined) this.latestSnapshotDigest = nextDigest;
    this.pendingPointerAction = nextPendingPointerAction;
    if (snapshot || invalidateSnapshot) {
      for (const entry of this.entries) {
        if (entry.message.role === "tool" && entry.snapshot) {
          entry.message.content = summary(JSON.parse(entry.message.content!), entry.actionOutcome);
          entry.snapshot = false;
        }
      }
    }
    this.entries.push({ message: { role: "tool", tool_call_id: id, content }, snapshot, ...(actionOutcome ? { actionOutcome } : {}) });
    return { stateChanged, ...(observationChanged !== undefined ? { observationChanged } : {}) };
  }
  messages(): Message[] {
    // A bounded list of complete rounds keeps the conversation protocol valid. Preserve the latest
    // observation if it precedes the retained rounds by summarizing intervening older rounds instead.
    const rounds = this.entries.flatMap((entry, index) => entry.message.role === "assistant" ? [index] : []);
    const cutoff = rounds.length > 6 ? rounds[rounds.length - 6]! : 2;
    const lastSnapshot = this.entries.findIndex(entry => entry.snapshot);
    const safeCutoff = lastSnapshot >= 2 && lastSnapshot < cutoff ? Math.max(2, this.previousAssistant(lastSnapshot)) : cutoff;
    if (safeCutoff > 2) this.entries.splice(2, safeCutoff - 2);
    const serialized = JSON.stringify(this.entries.map(entry => entry.message));
    if (Buffer.byteLength(serialized) > 160 * 1024) throw new RuntimeError("CONTEXT_LIMIT", "任务上下文达到限制，请拆分任务后继续。");
    return this.entries.map(entry => entry.message);
  }
  private previousAssistant(index: number): number {
    for (let i = index - 1; i >= 2; i--) if (this.entries[i]!.message.role === "assistant") return i;
    return 2;
  }
}
