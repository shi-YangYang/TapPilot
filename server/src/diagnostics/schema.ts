import { randomUUID } from "node:crypto";
import { z } from "zod";

// These are protocol categories, never copies of phone/model prose. Unknown
// values stay unknown: a plausible error string is not diagnostic evidence.
const errorCodes = [
  "NONE", "UNKNOWN", "ACTION_IN_PROGRESS", "ACTION_REJECTED", "ACTION_RECOVERY_EXHAUSTED", "ADB_FAILED", "ADB_PROTOCOL_ERROR",
  "ANDROID_ERROR", "AUTOMATION_STOPPED", "ACTION_NOT_COMPLETED", "COMPLETION_CONTEXT_CHANGED", "BRIDGE_CLOSED", "BRIDGE_TIMEOUT", "BRIDGE_PROTOCOL_ERROR", "BRIDGE_UNAVAILABLE", "BUSY",
  "CANCELLED", "CLIENT_CLOSED", "COMMAND_TIMEOUT", "CONFIRMATION_REQUIRED", "CONTEXT_LIMIT", "DEVICE_DISCONNECTED", "DEVICE_LOCKED",
  "DEVICE_SELECTION_REQUIRED", "DEVICE_TRANSPORT_DENIED", "DEVICE_UNAVAILABLE", "EMERGENCY_STOPPED", "GESTURE_CANCELLED",
  "GESTURE_COMPLETION_TIMEOUT", "INTERNAL_ERROR", "INVALID_ARGUMENT", "INVALID_MODEL_CONFIG", "INVALID_MODEL_URL", "INVALID_REQUEST",
  "INVALID_TASK", "INVALID_THREAD", "INVALID_TOOLS", "INVALID_TOOL_ARGUMENTS", "INVALID_TURN_LIMIT", "MANUAL_ACTION_REQUIRED", "EXECUTOR_UPGRADE_REQUIRED",
  "MODEL_CONNECTION_FAILED", "MODEL_EMPTY_RESPONSE", "MODEL_HTTP_ERROR", "MODEL_INVALID_RESPONSE", "MODEL_INVALID_TOOL_CALL",
  "MODEL_OUTPUT_LIMIT", "MODEL_RESPONSE_LIMIT", "MODEL_TIMEOUT", "NODE_DISABLED", "NODE_NOT_ACTIONABLE", "NODE_NOT_FOUND",
  "NODE_NOT_VISIBLE", "NOT_CLICKABLE", "NOT_EDITABLE", "NOT_IMPLEMENTED", "NOT_SCROLLABLE", "NO_ACTIVE_WINDOW", "NO_DEVICE", "NO_OBSERVATION",
  "NO_KNOWN_SNAPSHOT", "PASSWORD_FIELD_BLOCKED", "PAGE_CONTEXT_UNSTABLE", "PROTECTED_APP", "READ_REQUIRED", "REPEATED_ACTION", "REQUEST_TIMEOUT",
  "REQUEST_TOO_LARGE", "RESPONSE_TOO_LARGE", "RUNTIME_FAILED", "SENSITIVE_FIELD", "SERVICE_UNAVAILABLE", "SHUTTING_DOWN",
  "STALE_SNAPSHOT", "TARGET_CHANGED", "TASK_TIMEOUT", "TOOL_FAILED", "TOOL_INVALID_RESPONSE", "TOOL_RESULT_LIMIT", "TOOL_TIMEOUT",
  "TRUNCATED_SNAPSHOT", "TURN_LIMIT", "UNKNOWN_METHOD", "UNKNOWN_TOOL", "UNOBSERVED_ACTION_BATCH", "WIRELESS_CLOSED",
  "WIRELESS_DISCONNECTED", "WIRELESS_PROTOCOL_ERROR", "WIRELESS_SERVER_ERROR", "WIRELESS_SESSION_CHANGED", "WIRELESS_TIMEOUT",
] as const;
const reasons = [
  "NONE", "UNKNOWN", "INCOMPLETE_TREE", "INVALID_HIERARCHY", "TARGET_DISABLED", "TARGET_HIDDEN", "SENSITIVE_TARGET",
  "NO_CLICKABLE_TARGET", "HIDDEN_ANCESTOR", "INVALID_BOUNDS", "TARGET_CLIPPED", "AMBIGUOUS_TOUCH_TARGET", "TOUCH_TARGET_MISMATCH",
  "TREE_INCOMPLETE", "SESSION_CHANGED", "WINDOW_CHANGED", "TARGET_IDENTITY_CHANGED", "TARGET_AMBIGUOUS", "PAGE_CONTEXT_CHANGED",
  "TARGET_NOT_ACTIONABLE", "SNAPSHOT_MISSING", "TREE_STRUCTURE_CHANGED", "NODE_CONTENT_CHANGED", "NODE_BOUNDS_CHANGED",
  "NODE_STATE_CHANGED", "NODE_UNAVAILABLE", "WINDOW_OBSCURED",
] as const;
export const ActionKindSchema = z.enum([
  "none", "unknown", "get_device_info", "get_current_app", "get_ui_tree", "find_element", "wait_for_ui_change", "take_screenshot",
  "tap_element", "click_element", "input_text", "scroll", "swipe", "press_key", "open_settings",
]);
export const DiagnosticErrorCodeSchema = z.enum(errorCodes);
export const DiagnosticReasonSchema = z.enum(reasons);
const count = z.number().int().min(0).max(1_000_000);
const duration = z.number().finite().min(0).max(86_400_000);
const version = z.union([z.literal("unknown"), z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)]);

/** Location is structural, never a guess about the meaning of private UI text. */
export const ContextChangeSchema = z.object({
  region: z.enum(["target", "ancestor", "target_descendant", "peer_item", "outside_target", "mixed", "unknown"]),
  kind: z.enum(["content", "state", "structure", "geometry", "mixed", "unknown"]),
  changedNodes: z.number().int().min(0).max(500),
  targetMatched: z.boolean(), actionTargetMatched: z.boolean(),
}).strict();
export type ContextChange = z.infer<typeof ContextChangeSchema>;
export function safeContextChange(value: unknown): ContextChange | undefined {
  const parsed = ContextChangeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Every object is strict: extra fields reject the whole event, never strip a
 * task/answer/UI field and pretend its producer obeyed the privacy contract. */
export const DiagnosticEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventType: z.enum(["tool_result", "model_result", "run_finished"]),
  runId: z.string().uuid(),
  timestamp: z.number().int().min(0).max(8_640_000_000_000_000),
  stepIndex: count,
  actionKind: ActionKindSchema,
  // Set only from the common controller's validated native refusal envelope.
  executor: z.literal("node-v1").optional(),
  outcome: z.enum(["success", "failure", "cancelled", "unknown"]),
  // Program termination is distinct from an independently verified task result.
  runStatus: z.enum(["completed", "failed", "cancelled"]).optional(),
  failureStage: z.enum(["none", "model", "host_validation", "phone_validation", "dispatch", "observation", "runtime", "unknown"]),
  dispatchState: z.enum(["not_sent", "sent", "unknown", "not_applicable"]),
  acceptanceState: z.enum(["accepted", "rejected", "unknown", "not_applicable"]),
  // 'changed' is only an observation comparison, never proof of task success.
  effectState: z.enum(["changed", "unchanged", "unknown", "not_applicable"]),
  errorCode: DiagnosticErrorCodeSchema,
  reason: DiagnosticReasonSchema,
  contextChange: ContextChangeSchema.optional(),
  contextConflictCount: z.number().int().min(1).max(2).optional(),
  timings: z.object({
    totalMs: duration.optional(), modelMs: duration.optional(), toolMs: duration.optional(),
    preflightMs: duration.optional(), phoneMs: duration.optional(), observationMs: duration.optional(), snapshotAgeMs: duration.optional(),
  }).strict().optional(),
  changes: z.object({
    observationChanged: z.boolean().optional(), windowChanged: z.boolean().optional(),
    structureChanged: z.boolean().optional(), targetContentChanged: z.boolean().optional(),
    targetBoundsChanged: z.boolean().optional(), targetStateChanged: z.boolean().optional(),
    nodeCountBefore: count.optional(), nodeCountAfter: count.optional(),
  }).strict().optional(),
  versions: z.object({ host: version, androidApi: z.number().int().min(1).max(1000).optional(),
    phone: version.optional(), protocol: z.number().int().min(1).max(1000).optional() }).strict(),
}).strict();
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;
export const createDiagnosticRunId = (): string => randomUUID();
export const safeDiagnosticErrorCode = (value: unknown): DiagnosticEvent["errorCode"] =>
  typeof value === "string" && /^MODEL_HTTP_[1-5]\d{2}$/.test(value) ? "MODEL_HTTP_ERROR" :
    DiagnosticErrorCodeSchema.safeParse(value).success ? value as DiagnosticEvent["errorCode"] : "UNKNOWN";
export const safeDiagnosticReason = (value: unknown): DiagnosticEvent["reason"] => DiagnosticReasonSchema.safeParse(value).success ? value as DiagnosticEvent["reason"] : "UNKNOWN";
export const safeDiagnosticActionKind = (value: unknown): DiagnosticEvent["actionKind"] => ActionKindSchema.safeParse(value).success ? value as DiagnosticEvent["actionKind"] : "unknown";

export type FailureSummary = Pick<DiagnosticEvent, "eventType" | "versions" | "actionKind" | "failureStage" | "errorCode" | "reason" | "dispatchState" | "acceptanceState" | "effectState"> & {
  count: number; runCount: number; firstSeen: number; lastSeen: number;
  evidence: "reported_metadata"; cause: "unknown";
};
export function summarizeFailures(events: readonly DiagnosticEvent[]): FailureSummary[] {
  const groups = new Map<string, { summary: FailureSummary; runs: Set<string> }>();
  for (const input of events) {
    const parsed = DiagnosticEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.outcome !== "failure") continue;
    const e = parsed.data;
    const key = JSON.stringify([e.eventType, e.versions, e.actionKind, e.failureStage, e.errorCode, e.reason, e.dispatchState, e.acceptanceState, e.effectState]);
    let group = groups.get(key);
    if (!group) {
      group = { summary: { eventType: e.eventType, versions: e.versions, actionKind: e.actionKind, failureStage: e.failureStage, errorCode: e.errorCode, reason: e.reason,
        dispatchState: e.dispatchState, acceptanceState: e.acceptanceState, effectState: e.effectState,
        count: 0, runCount: 0, firstSeen: e.timestamp, lastSeen: e.timestamp, evidence: "reported_metadata", cause: "unknown" }, runs: new Set() };
      groups.set(key, group);
    }
    group.summary.count++;
    group.runs.add(e.runId);
    group.summary.runCount = group.runs.size;
    group.summary.firstSeen = Math.min(group.summary.firstSeen, e.timestamp);
    group.summary.lastSeen = Math.max(group.summary.lastSeen, e.timestamp);
  }
  return [...groups.values()].map(group => group.summary).sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}
