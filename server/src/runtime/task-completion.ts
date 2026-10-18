import { fullObservation } from "./context.js";
import type { AgentTool } from "./model.js";
import { hasSettlingObservation, isSemanticObservation, observationQualitySchema } from "../observation-contract.js";

type Evidence = { snapshotId: string; evidenceNodeIds: string[] };
export type FinishTaskRequest = { status: "completed"; answer: string } & Evidence |
  { status: "blocked"; answer: string } & Partial<Evidence>;
export type TaskCompletionValidation = { ok: true; request: FinishTaskRequest } |
  { ok: false; code: "INVALID_FINISH_TASK" | "COMPLETION_EVIDENCE_INVALID"; message: string };

/** This is a runtime decision, never a command sent to the phone. */
export const finishTaskTool: AgentTool = {
  name: "finish_task",
  description: "Finish with a user-facing answer. completed requires all requested work to be supported by the latest native observation; provide its snapshotId and evidenceNodeIds. blocked explains what cannot be completed. The host checks freshness without another model turn; this tool sends no phone action and does not judge task meaning. With screenshot-only evidence, answer directly instead.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["completed", "blocked"] },
      answer: { type: "string", minLength: 1, maxLength: 8000, pattern: "\\S", description: "Concise user-facing result in the user's language, or what remains blocked." },
      snapshotId: { type: "string", minLength: 1, maxLength: 128, pattern: "\\S", description: "The latest full native observation's snapshotId." },
      evidenceNodeIds: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" },
        description: "Current visible nodes supporting the result, such as destination headings, requested content or control states. These are evidence references, not instructions." },
    },
    required: ["status", "answer"],
    oneOf: [
      { properties: { status: { const: "completed" } }, required: ["snapshotId", "evidenceNodeIds"] },
      { properties: { status: { const: "blocked" } } },
    ],
  },
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && value.trim().length > 0;
const invalidArguments = (): TaskCompletionValidation => ({ ok: false, code: "INVALID_FINISH_TASK",
  message: "Supply completed or blocked and a nonempty answer. Completed requires the latest snapshotId and 1 to 16 unique evidenceNodeIds from that observation." });
const invalidEvidence = (): TaskCompletionValidation => ({ ok: false, code: "COMPLETION_EVIDENCE_INVALID",
  message: "Completion evidence must refer to meaningful, visible, non-password nodes in the current complete, usable native observation. Inspect the supplied current evidence; no phone action was sent." });

function meaningfulNode(node: Record<string, unknown>): boolean {
  if (node.visible === false || node.password === true || node.dataSensitive === true || node.accessibilityDataSensitive === true) return false;
  return [node.text, node.contentDescription].some(value => boundedText(value, Number.MAX_SAFE_INTEGER)) ||
    node.enabled !== false && [node.clickable, node.editable, node.scrollable].some(value => value === true);
}

/** Validates references only. The model remains responsible for ALL task requirements;
 * matching nodes, a changed page and accepted actions are not semantic task verification.
 * The caller retains its unresolved-action and final session/window continuity checks.
 */
export function validateTaskCompletion(args: unknown, currentObservation: unknown): TaskCompletionValidation {
  if (!object(args) || Object.keys(args).some(key => !["status", "answer", "snapshotId", "evidenceNodeIds"].includes(key)) ||
      (args.status !== "completed" && args.status !== "blocked") || !boundedText(args.answer, 8000)) return invalidArguments();
  if (args.snapshotId !== undefined && !boundedText(args.snapshotId, 128)) return invalidArguments();
  if (args.evidenceNodeIds !== undefined && (!Array.isArray(args.evidenceNodeIds) || args.evidenceNodeIds.length < 1 ||
      args.evidenceNodeIds.length > 16 || !args.evidenceNodeIds.every(value => boundedText(value, 64)) ||
      new Set(args.evidenceNodeIds).size !== args.evidenceNodeIds.length)) return invalidArguments();
  if (args.status === "blocked") return { ok: true, request: { status: "blocked", answer: args.answer,
    ...(typeof args.snapshotId === "string" ? { snapshotId: args.snapshotId } : {}),
    ...(Array.isArray(args.evidenceNodeIds) ? { evidenceNodeIds: [...args.evidenceNodeIds] as string[] } : {}),
  } };
  if (typeof args.snapshotId !== "string" || !Array.isArray(args.evidenceNodeIds)) return invalidArguments();

  const observation = fullObservation(currentObservation);
  if (!observation || observation.snapshotId !== args.snapshotId || observation.truncated !== false ||
      !Array.isArray(observation.nodes) || hasSettlingObservation(observation) ||
      (isSemanticObservation(observation) && observationQualitySchema.safeParse(observation.quality).data?.status !== "usable")) return invalidEvidence();
  const nodes = observation.nodes.filter(object);
  const meaningfulNodes = nodes.filter(meaningfulNode);
  for (const nodeId of args.evidenceNodeIds) {
    const matches = nodes.filter(node => node.nodeId === nodeId);
    if (matches.length !== 1 || !meaningfulNode(matches[0]!)) return invalidEvidence();
    const content = evidenceContent(matches[0]!);
    if (meaningfulNodes.filter(node => evidenceContent(node) === content).length !== 1) return {
      ok: false, code: "COMPLETION_EVIDENCE_INVALID",
      message: "The cited node has indistinguishable visible content and state elsewhere in the current observation. Cite distinguishable evidence nodes, such as a unique destination heading or labeled control state; no phone action was sent.",
    };
  }
  return { ok: true, request: { status: "completed", answer: args.answer, snapshotId: args.snapshotId, evidenceNodeIds: [...args.evidenceNodeIds] as string[] } };
}

function evidenceContent(node: Record<string, unknown>): string {
  // Empty strings and false capability flags may be omitted by the client.
  // Unknown state remains distinct from false; an unchecked control is evidence.
  return JSON.stringify({
    ...Object.fromEntries(["text", "contentDescription", "resourceId", "className"].map(key => [key, typeof node[key] === "string" ? node[key] : ""])),
    ...Object.fromEntries(["clickable", "editable", "scrollable", "checkable"].map(key => [key, node[key] === true])),
    ...Object.fromEntries(["enabled", "checked", "selected", "showingHintText"].map(key => [key, typeof node[key] === "boolean" ? node[key] : null])),
  });
}

/** Recheck only the model's cited evidence after the caller's final fresh read.
 * Handles and geometry can change; unrelated labels are not evidence. The caller
 * separately checks session/app/window continuity. This still does not validate
 * whether the cited content satisfies the user's task.
 */
export function completionEvidenceUnchanged(request: FinishTaskRequest, before: unknown, after: unknown): boolean {
  if (request.status !== "completed" || !validateTaskCompletion(request, before).ok) return false;
  const previous = fullObservation(before)!;
  const current = fullObservation(after);
  if (!current || current.truncated !== false || !Array.isArray(current.nodes) || hasSettlingObservation(current) ||
      (isSemanticObservation(current) && observationQualitySchema.safeParse(current.quality).data?.status !== "usable")) return false;
  const previousNodes = (previous.nodes as unknown[]).filter(object).filter(meaningfulNode);
  const currentNodes = current.nodes.filter(object).filter(meaningfulNode);
  return request.evidenceNodeIds.every(nodeId => {
    const cited = previousNodes.find(node => node.nodeId === nodeId);
    if (!cited) return false;
    const content = evidenceContent(cited);
    // Without a unique semantic identity we cannot establish that this is still
    // the cited control, even if its old nodeId happens to have been recycled.
    return previousNodes.filter(node => evidenceContent(node) === content).length === 1 &&
      currentNodes.filter(node => evidenceContent(node) === content).length === 1;
  });
}
