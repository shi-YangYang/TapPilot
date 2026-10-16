import { createHash } from "node:crypto";
import type { Message } from "./model.js";
import { RuntimeError } from "./model.js";

type Entry = { message: Message; snapshot: boolean };
const OMIT_FROM_DIGEST = new Set(["snapshotId", "revision", "meta", "timings", "durationMs", "timestamp"]);

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

function fullObservation(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.snapshotId === "string" && Array.isArray(obj.nodes)) return obj;
  for (const item of Object.values(obj)) {
    const found = fullObservation(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function summary(value: unknown): string {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : {};
  return JSON.stringify({ ok: obj.ok !== false, ...(typeof error.code === "string" ? { error: { code: error.code } } : {}),
    superseded: true, note: "Earlier tool details removed. Only the latest observation may be used for node actions." });
}

/** Keep valid tool-call/result pairs, but never keep old full UI trees in subsequent requests. */
export class Conversation {
  private entries: Entry[];
  private latestSnapshotDigest = "";
  constructor(system: string, task: string) {
    this.entries = [{ message: { role: "system", content: system }, snapshot: false }, { message: { role: "user", content: task }, snapshot: false }];
  }
  assistant(message: Message): void { this.entries.push({ message, snapshot: false }); }
  result(id: string, value: Record<string, unknown>, invalidateSnapshot = false): { stateChanged: boolean; observationChanged?: boolean } {
    const snapshot = hasSnapshot(value);
    let stateChanged = false;
    let observationChanged: boolean | undefined;
    let nextDigest: string | undefined;
    if (snapshot || invalidateSnapshot) {
      // Compare UI content itself, not an action/read wrapper or changing revision/timing fields.
      // A partial find_element result is not evidence that the screen changed.
      const observation = fullObservation(value);
      if (observation) {
        const digest = signature(observation);
        if (this.latestSnapshotDigest) observationChanged = digest !== this.latestSnapshotDigest;
        stateChanged = digest !== this.latestSnapshotDigest;
        nextDigest = digest;
      }
    }
    const result = value.result as Record<string, unknown> | undefined;
    const action = result?.action as Record<string, unknown> | undefined;
    // This is host-authored feedback, never a promotion of instructions found in the UI.
    const stored = invalidateSnapshot && value.ok === true && action?.accepted === true && observationChanged === false ? {
      ...value,
      hostGuidance: { code: "OBSERVATION_UNCHANGED", message: "Android accepted the action, but the observed UI is unchanged. Acceptance does not prove the intended effect. Wait for the expected control or read the UI once before deciding again; an animation may still be running. Do not blindly repeat. If a later fresh observation confirms that a native click had no effect and the intended target is unambiguous, consider one stationary swipe using coordinates inside that target's current observed bounds. Never use this fallback for a protected or restricted action." },
    } : value;
    const content = JSON.stringify(stored);
    if (Buffer.byteLength(content) > 96 * 1024) throw new RuntimeError("TOOL_RESULT_LIMIT", "界面数据过大，请使用更小的 UI 树或控件查找。动作结果不会自动重试。");
    // Commit history and comparison state only after the entire stored result passes its limit.
    if (nextDigest !== undefined) this.latestSnapshotDigest = nextDigest;
    if (snapshot || invalidateSnapshot) {
      for (const entry of this.entries) {
        if (entry.message.role === "tool" && entry.snapshot) {
          entry.message.content = summary(JSON.parse(entry.message.content!));
          entry.snapshot = false;
        }
      }
    }
    this.entries.push({ message: { role: "tool", tool_call_id: id, content }, snapshot });
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
