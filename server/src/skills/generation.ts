import { z } from "zod";
import { completion, RuntimeError, type AgentTool, type Message, type ModelConfig, type ModelFetch } from "../runtime/model.js";
import { modelScope } from "../learning/schema.js";
import { FailureEpisodeSchema, type FailureEpisode } from "./trace.js";
import { SkillFeedbackSchema, SkillSpecSchema, skillHash, semanticSkillHash, matchesScope, type SkillFeedback, type SkillSpec } from "./schema.js";
import { safeSkillFailure } from "./failure.js";
import { SkillTrainingFeedbackSchema, type SkillTrainingFeedback } from "./training-feedback.js";
import { decodeSkillProposalJson, diagnoseSkillProposal, generationEvidence, parseSkillProposal, SKILL_PROPOSAL_GRAMMAR, SKILL_LINEAR_PROPOSAL_JSON_SCHEMA, SkillLinearProposalSchema, type SkillProposalDiagnostic } from "./generation-wire.js";

export { SkillProposalSchema } from "./generation-wire.js";
export type { SkillProposalDiagnostic } from "./generation-wire.js";
export interface GenerateSkillOptions {
  model: ModelConfig; modelFetch?: ModelFetch; signal: AbortSignal; now?: number;
  parent?: SkillSpec; feedback?: readonly SkillFeedback[];
  evaluationFeedback?: SkillTrainingFeedback;
  onInvalidProposal?: (diagnostic: SkillProposalDiagnostic) => void;
  outputMode?: "json" | "tool";
}
function failure(code: string): RuntimeError { return new RuntimeError(code, code); }
const proposalTool: AgentTool = { name: "propose_skill", description: "Return one unproven procedural skill as structured data, optionally with a separate prevention procedure. This does not execute phone operations or adopt a skill. Choose the shortest useful allowed operation sequence; all conditions and operations must come from current structural evidence.", inputSchema: SKILL_LINEAR_PROPOSAL_JSON_SCHEMA };

/** Generate a new bounded procedure, rather than select a canned strategy.
 * The model sees sanitized structural evidence only; lineage, identity, scope,
 * expiry and activation are assigned by the host and cannot be proposed. */
export async function generateSkill(input: FailureEpisode, options: GenerateSkillOptions): Promise<SkillSpec> {
  if (options.signal.aborted) throw failure("SKILL_GENERATION_CANCELLED");
  const parsed = FailureEpisodeSchema.safeParse(input);
  if (!parsed.success) throw failure("SKILL_INVALID_EPISODE");
  const episode = parsed.data;
  let profile: string;
  try { profile = modelScope(options.model).modelProfile; } catch { throw failure("SKILL_INVALID_MODEL"); }
  if (profile !== episode.scope.modelProfile) throw failure("SKILL_MODEL_SCOPE_MISMATCH");
  const parentResult = options.parent === undefined ? undefined : SkillSpecSchema.safeParse(options.parent);
  if (parentResult && !parentResult.success) throw failure("SKILL_INVALID_PARENT");
  const parent = parentResult?.success ? parentResult.data : undefined;
  if (parent && (!matchesScope(parent.scope, episode.scope) || !matchesScope(episode.scope, parent.scope))) throw failure("SKILL_PARENT_SCOPE_MISMATCH");
  const feedbackResult = z.array(SkillFeedbackSchema).max(8).safeParse(options.feedback ?? []);
  if (!feedbackResult.success) throw failure("SKILL_INVALID_FEEDBACK");
  const feedback = feedbackResult.data;
  if (feedback.length && (!parent || feedback.some(item => item.skillHash !== skillHash(parent)))) throw failure("SKILL_FEEDBACK_PARENT_MISMATCH");
  const evaluationResult = options.evaluationFeedback === undefined ? undefined : SkillTrainingFeedbackSchema.safeParse(options.evaluationFeedback);
  if (evaluationResult && !evaluationResult.success) throw failure("SKILL_INVALID_FEEDBACK");
  const evaluationFeedback = evaluationResult?.success ? evaluationResult.data : undefined;
  if (evaluationFeedback && (!parent || evaluationFeedback.skillHash !== skillHash(parent))) throw failure("SKILL_FEEDBACK_PARENT_MISMATCH");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 30 * 86_400_000) throw failure("SKILL_INVALID_TIME");
  const reportInvalid = (diagnostic: SkillProposalDiagnostic): void => {
    try { options.onInvalidProposal?.(diagnostic); } catch { /* diagnostic observers cannot affect proposal validation */ }
  };
  const rejectProposal = (diagnostic: SkillProposalDiagnostic): never => {
    reportInvalid(diagnostic);
    throw failure("SKILL_INVALID_PROPOSAL");
  };
  const toolMode = options.outputMode !== "json";
  const messages: Message[] = [{ role: "system", content: [
      "Propose one short, reusable, unproven phone procedure from sanitized structural evidence. Compose allowed operations yourself; there are no canned skill IDs.",
      "Preserve independently verified business success and safety. Against the existing baseline, reduce actual contextRefusals, or reduce model requests without increasing contextRefusals. Short programs alone are not improvement. An episode with termination=completed can contain a failure that the existing runtime already recovered from; it is not business-success proof. Repeating existing recovery is not a new benefit.",
      toolMode ? "Return the proposal using exactly one propose_skill data-output call with no accompanying text. Its schema defines the permitted fields and operation vocabulary. This tool only returns data; no operation will execute and no proposal is automatically adopted." : "Return exactly one JSON object, no prose or tools.",
      toolMode ? "Choose a short linear procedure from the allowed operations. Conditions use frozen current facts, never future results." : "Prefer a short linear procedure. Use a graph only when distinct evidence requires a branch. Conditions use frozen current facts, never future results. Graphs have 2–8 nodes, entry 0, every node reachable, at least one step, forward-only edges and an end on every path.",
      "before/after numbers index the losslessly factored observations array. Scope, identity and expiry are host-owned; never propose them.",
      "Optional prevention has its own entryConditions and operations. Consider it in an eligible decision window, initially or after a genuinely successful mutation returns a complete observation. Each application requires a new comparison: two fresh complete observations, same app/window, unchanged structure/context, passive text-only differences (observedLabelChanges=yes). The host may add one bounded event wait/read without another model round, not before every action. Target facts, priorActionAccepted, priorEffectUnknown, nativeContextChange and labelOnlyContextChange stay unknown. Review each current changedLabelNodeIds entry semantically; counts cannot prove harmlessness. Use only reviewed current-snapshot allowances through normal guarded tools. Steps remain conditional on current user intent; never replay the preceding mutation or reuse old IDs. Propose prevention only when useful evidence supports it.",
      "Unknown evidence stays unknown. Counts cannot prove identity, recipient, text meaning, cause, success or permission; tool acceptance is not business success. Never weaken target/context/sensitivity/freshness guards or replay an action with unknown effect.",
      "input_text uses native ACTION_SET_TEXT on the unique editable field without requiring focus or a visible keyboard. Do not insert a tap or focus_existing_input merely because targetFocused or imeVisible is no/unknown, or a context check failed. Focus needs explicit current evidence that the editor requires it; otherwise input_requested_text uses the editable node directly with every native guard intact.",
      "inspect_changed_labels examines latest observation.changedLabelNodeIds, not proof of harmlessness. allow_unrelated_status_labels requires individual semantic review: only passive labels unrelated to user intent and business context may be allowed for the next existing guarded action. Never allow recipient/account/amount/password or other meaningful changes. Counts cannot justify blanket allowances; use current snapshot IDs and every native protection.",
      "Use current_task_target/current_task_requested_text only for the existing user's task. No UI/task/input text, app labels, node IDs, coordinates, secrets, code, URLs, commands or extra fields. Stop on session/recipient change, protection, cancellation or ambiguity.",
      ...(parent ? ["Choose an evidence-based revision of the parent. Preserve measured training gains: overall rejection does not prove every component failed. Without corresponding evidence, do not discard an existing prevention procedure or revert to baseline reactive recovery merely to make the proposal different. You choose the composition; do not infer causes from withheld tests. Exact unchanged proposals are not revisions. Fresh training and holdout evaluation determines adoption."] : []),
      ...(evaluationFeedback ? ["evaluationFeedback pairs compare baseline and parent on actual training runs. success/unsafe/falseCompletion are independently checked; applications counts skill use, requests model requests, contextRefusals native refusals. Compare pairs: both completing is not improvement, nor is not_applied. No holdout/safety case details, no permission or adoption authority; fresh evaluation remains required."] : []),
      ...(toolMode ? [] : [SKILL_PROPOSAL_GRAMMAR]),
    ].join("\n") }, { role: "user", content: JSON.stringify(generationEvidence(episode, parent, feedback, evaluationFeedback)) }];
  // One schema-feedback correction is allowed. It uses the caller's same fetch
  // and signal, so job/request budgets still cover both calls. Transport errors,
  // unknown tools and repeated calls are never retried through this path.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (options.signal.aborted) throw failure("SKILL_GENERATION_CANCELLED");
    let result: Awaited<ReturnType<typeof completion>>;
    try {
      result = await completion(options.model, messages, toolMode ? [proposalTool] : [], options.signal, options.modelFetch, "skill_generation");
    } catch (error) {
      if (options.signal.aborted) throw failure("SKILL_GENERATION_CANCELLED");
      const reason = safeSkillFailure(error, "generation");
      throw failure(reason.code === "MODEL_HTTP_ERROR" ? `MODEL_HTTP_${reason.httpStatus}` : reason.code);
    }
    if (options.signal.aborted) throw failure("SKILL_GENERATION_CANCELLED");
    let content: string, toolOutput = false;
    const calls = result.message.tool_calls;
    if (calls?.length) {
      if (!toolMode) return rejectProposal({ format: "other", channel: "tool", rejection: "unexpected_tool" });
      if (calls.length !== 1) return rejectProposal({ format: "other", channel: "tool", rejection: "multiple_tool_calls" });
      if (calls[0]!.function.name !== proposalTool.name) return rejectProposal({ format: "other", channel: "tool", rejection: "unexpected_tool" });
      // The one validated tool payload is authoritative. Providers may attach
      // explanatory content; it is neither parsed, persisted nor executed.
      content = calls[0]!.function.arguments; toolOutput = true;
    } else {
      if (!result.message.content?.trim()) return rejectProposal({ format: "other", rejection: "missing_content" });
      content = result.message.content;
    }
    let proposal: ReturnType<typeof parseSkillProposal> | undefined;
    try {
      const raw = toolOutput ? JSON.parse(content) : decodeSkillProposalJson(content);
      if (!toolOutput || SkillLinearProposalSchema.safeParse(raw).success) proposal = parseSkillProposal(raw);
    } catch { /* a syntax error gets the same one bounded format correction */ }
    if (proposal?.success) {
      const spec = SkillSpecSchema.parse({ schemaVersion: 1, scope: episode.scope, trigger: episode.trigger,
        ...proposal.data, lineage: { ...(parent ? { parentHash: skillHash(parent) } : {}), negativeFeedback: feedback },
        basis: "hypothesis", expiresAt: now + 30 * 86_400_000 });
      if (parent && semanticSkillHash(parent) === semanticSkillHash(spec)) throw failure("SKILL_UNCHANGED_PROPOSAL");
      return spec;
    }
    const diagnostic: SkillProposalDiagnostic = { ...diagnoseSkillProposal(content), ...(toolOutput ? { channel: "tool", rejection: "invalid_arguments" } as const : {}) };
    reportInvalid(diagnostic);
    if (attempt === 1) throw failure("SKILL_INVALID_PROPOSAL");
    const message = "The proposed data did not pass strict syntax/schema validation. Return one complete corrected proposal, not a patch or explanation. Preserve the intended procedure only where the schema permits it; choose every missing decision yourself. Linear procedures require entryConditions, steps and outcome, including an outcome for optional prevention. Do not add authority, free text or fields outside the schema. Validation: " + JSON.stringify(diagnostic);
    // Preserve the prior response only in this request's in-memory conversation.
    // Diagnostics and storage never receive the raw arguments/content.
    if (toolOutput) messages.push(
      { role: "assistant", content: null, tool_calls: calls },
      { role: "tool", tool_call_id: calls![0]!.id, content: JSON.stringify({ ok: false, error: { code: "SKILL_INVALID_PROPOSAL", message } }) },
    );
    else messages.push({ role: "assistant", content }, { role: "user", content: message });
  }
  throw failure("SKILL_INVALID_PROPOSAL");
}
