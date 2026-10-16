import { z } from "zod";
import { DiagnosticEventSchema, summarizeFailures, type DiagnosticEvent } from "../diagnostics/schema.js";
import { endpointFor, type ModelConfig, type ModelFetch } from "../runtime/model.js";
import { CandidateSpecSchema, ModelFamilySchema, ModelProfileSchema, modelScope, StrategySchema, type CandidateSpec } from "./schema.js";
const proposalsSchema = z.object({ proposals: z.array(z.object({ group: z.number().int().min(0).max(19), strategy: StrategySchema }).strict()).max(20) }).strict();
const strategies: Record<string, CandidateSpec["strategy"]> = {
  STALE_SNAPSHOT: "wait_for_stability", TARGET_CHANGED: "stop_on_context_change", NODE_NOT_ACTIONABLE: "choose_actionable_ancestor",
  NO_OBSERVATION: "use_latest_observation", BRIDGE_CLOSED: "confirm_effect_before_retry", BRIDGE_TIMEOUT: "confirm_effect_before_retry",
};
export async function summarizeCandidates(inputs: readonly unknown[], options: { hostVersion: string; modelFamily?: z.infer<typeof ModelFamilySchema>; modelProfile?: string; now?: number; model?: ModelConfig; modelFetch?: ModelFetch }): Promise<CandidateSpec[]> {
  if (inputs.length > 500) throw new Error("LEARNING_INPUT_LIMIT");
  const scope = options.model ? modelScope(options.model) : {
    ...(options.modelFamily ? { modelFamily: ModelFamilySchema.parse(options.modelFamily) } : {}),
    ...(options.modelProfile ? { modelProfile: ModelProfileSchema.parse(options.modelProfile) } : {}),
  };
  if (options.model && (options.modelProfile && options.modelProfile !== scope.modelProfile || options.modelFamily && options.modelFamily !== scope.modelFamily)) throw new Error("LEARNING_MODEL_SCOPE_MISMATCH");
  // Reject, rather than silently strip, unexpected fields or UI/secret text.
  const events: DiagnosticEvent[] = inputs.map(input => { const result = DiagnosticEventSchema.safeParse(input); if (!result.success) throw new Error("LEARNING_INVALID_DIAGNOSTICS"); return result.data; });
  const groups = summarizeFailures(events).slice(0, 20);
  let proposals = groups.flatMap((group, index) => strategies[group.errorCode] ? [{ group: index, strategy: strategies[group.errorCode]! }] : []);
  if (options.model && groups.length) {
    let content: string;
    try {
      const response = await (options.modelFetch ?? globalThis.fetch)(endpointFor(options.model), { method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
        headers: { "Content-Type": "application/json", ...(options.model.apiKey ? { Authorization: `Bearer ${options.model.apiKey}` } : {}) },
        body: JSON.stringify({ model: options.model.model, stream: false, messages: [
          { role: "system", content: `Propose hypotheses only from diagnostic metadata. Return JSON {"proposals":[{"group":0,"strategy":"enum"}]}. Strategies: ${StrategySchema.options.join(",")}. Never claim an unknown cause is proven. No prose, extra keys, new strategy, code, UI content, node ID or coordinates.` },
          { role: "user", content: JSON.stringify(groups) },
        ] }) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 64 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(item.value); } }
      finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data.choices?.[0]?.finish_reason === "length" || typeof data.choices?.[0]?.message?.content !== "string") throw new Error();
      content = data.choices[0].message.content;
    } catch { throw new Error("LEARNING_SUMMARY_MODEL_FAILED"); }
    const parsed = proposalsSchema.safeParse((() => { try { return JSON.parse(content); } catch { return null; } })());
    if (!parsed.success || parsed.data.proposals.some(p => p.group >= groups.length)) throw new Error("LEARNING_INVALID_PROPOSAL");
    proposals = parsed.data.proposals;
  }
  const now = options.now ?? Date.now();
  const found = new Map<string, CandidateSpec>();
  for (const proposal of proposals) {
    const group = groups[proposal.group]!;
    const spec = CandidateSpecSchema.parse({ schemaVersion: 1, trigger: { errorCode: group.errorCode, reason: group.reason, actionKind: group.actionKind },
      preconditions: { failureStage: group.failureStage, dispatchState: group.dispatchState, acceptanceState: group.acceptanceState },
      strategy: proposal.strategy, scope: { hostVersion: options.hostVersion, ...scope }, basis: "hypothesis", expiresAt: now + 30 * 86_400_000 });
    found.set(JSON.stringify(spec), spec);
  }
  return [...found.values()];
}
