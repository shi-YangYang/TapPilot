import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { completion, RuntimeError, type ModelConfig, type ModelFetch } from "../runtime/model.js";
import { modelScope } from "../learning/schema.js";
import { FailureEpisodeSchema, type FailureEpisode } from "./trace.js";
import { PredicateSchema, SkillProgramSchema, SkillFeedbackSchema, SkillSpecSchema, skillHash, semanticSkillHash, matchesScope, type SkillFeedback, type SkillSpec } from "./schema.js";

export const SkillProposalSchema = z.object({ entryConditions: z.array(PredicateSchema).max(6), program: SkillProgramSchema }).strict();
export interface GenerateSkillOptions {
  model: ModelConfig; modelFetch?: ModelFetch; signal: AbortSignal; now?: number;
  parent?: SkillSpec; feedback?: readonly SkillFeedback[];
}
function failure(code: string): RuntimeError { return new RuntimeError(code, code); }

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
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 30 * 86_400_000) throw failure("SKILL_INVALID_TIME");
  let content: string;
  try {
    const result = await completion(options.model, [{ role: "system", content: [
      "You propose a reusable, unproven phone interaction procedure from strictly sanitized structural traces. Return exactly one JSON object matching the supplied schema; no prose or tools.",
      "Invent a useful combination of conditions, branches and parameterized steps from the allowed operation vocabulary. You are not choosing a canned skill ID. Conditions and all branches use the current frozen host facts, so never assume a later operation already changed those facts.",
      "An acyclic graph has 2–8 nodes, entry 0, all nodes reachable, every successor index strictly greater than its source. Every path must terminate in an end node. Include at least one procedural step.",
      "Evidence is incomplete: unknown stays unknown. Do not infer an app identity, recipient, text meaning, cause, successful action or permission from counts. A tool acceptance is not a successful business outcome. No proposal can weaken target/context/sensitivity/freshness checks or replay an action with unknown effect.",
      "Use current_task_target/current_task_requested_text symbols only when the existing user task requires them. Never include UI text, task text, input, app labels, node IDs, coordinates, secrets, code, URLs, commands, or extra fields. A changed session/recipient, protection, cancellation or ambiguity requires stopping, not a workaround.",
      "When a parent and negative feedback are supplied, propose a different composition addressing that evidence. Do not merely repeat the rejected parent. Training and holdout tests, not your explanation, determine whether it can be adopted.",
      `JSON schema: ${JSON.stringify(zodToJsonSchema(SkillProposalSchema, { $refStrategy: "none" }))}`,
    ].join("\n") }, { role: "user", content: JSON.stringify({
      scope: episode.scope, trigger: episode.trigger, steps: episode.steps, termination: episode.termination,
      ...(parent ? { parent: { entryConditions: parent.entryConditions, program: parent.program } } : {}), negativeFeedback: feedback,
    }) }], [], options.signal, options.modelFetch);
    if (result.message.tool_calls?.length || !result.message.content) throw failure("SKILL_INVALID_PROPOSAL");
    content = result.message.content;
  } catch (error) {
    if (options.signal.aborted) throw failure("SKILL_GENERATION_CANCELLED");
    if (error instanceof RuntimeError && error.code === "SKILL_INVALID_PROPOSAL") throw error;
    throw failure("SKILL_GENERATION_FAILED");
  }
  if (options.signal.aborted) throw failure("SKILL_GENERATION_CANCELLED");
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw failure("SKILL_INVALID_PROPOSAL"); }
  const proposal = SkillProposalSchema.safeParse(raw);
  if (!proposal.success) throw failure("SKILL_INVALID_PROPOSAL");
  const spec = SkillSpecSchema.parse({ schemaVersion: 1, scope: episode.scope, trigger: episode.trigger,
    ...proposal.data, lineage: { ...(parent ? { parentHash: skillHash(parent) } : {}), negativeFeedback: feedback },
    basis: "hypothesis", expiresAt: now + 30 * 86_400_000 });
  if (parent && semanticSkillHash(parent) === semanticSkillHash(spec)) throw failure("SKILL_UNCHANGED_PROPOSAL");
  return spec;
}
