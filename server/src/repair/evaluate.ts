import { Adb } from "../adb.js";
import { createPhoneClient } from "../client-tools.js";
import { runAgent, type ModelFetch } from "../runtime/index.js";
import { fullObservation } from "../runtime/context.js";
import { currentObservation, observedPolicy } from "../eval/runner.js";
import { ScenarioPhone, type Json } from "../eval/synthetic-phone.js";
import { resultFor, summarize, type EvaluationResult } from "../eval/report.js";
import { generateScenarios, type Scenario } from "../eval/scenarios.js";
import { safeDiagnosticErrorCode } from "../diagnostics/schema.js";
import { RepairError, type RepairIncident } from "./schema.js";
import type { ProjectionSandbox } from "./sandbox.js";

/** Candidate code only transforms synthetic raw observations. Endpoint state,
 * action validation, planner fixture and verdict are owned by this trusted host. */
export async function evaluateProjection(sandbox: ProjectionSandbox, scenarios: readonly Scenario[], signal?: AbortSignal): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];
  for (const scenario of scenarios) {
    signal?.throwIfAborted();
    const phone = new ScenarioPhone(scenario);
    const client = createPhoneClient(phone, new Adb());
    const cancelled = new AbortController();
    const raw = new Map<string, Json>();
    const errors: string[] = [];
    let request = 0;
    const modelFetch: ModelFetch = async (_url, init) => {
      if (scenario.mechanism === "cancel_protected" && scenario.parameters.cancel) { phone.cancel(); cancelled.abort(); }
      const body = JSON.parse(String(init.body));
      const projectedByProduction = currentObservation(body);
      let projected: Json | undefined;
      if (projectedByProduction) {
        const input = raw.get(projectedByProduction.snapshotId);
        if (!input) throw new RepairError("RAW_OBSERVATION_MISSING");
        // Do not run the candidate against already-shortened model data.
        const value = await sandbox.project(input);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepairError("INVALID_PROJECTION");
        projected = value as Json;
        if (projected.snapshotId !== input.snapshotId || projected.windowId !== input.windowId || projected.packageName !== input.packageName ||
          !Array.isArray(projected.nodes) || projected.nodes.length > 500) throw new RepairError("INVALID_PROJECTION");
      }
      const decision = observedPolicy(projected, body, scenario);
      return new Response(JSON.stringify({ choices: [{ finish_reason: decision ? "tool_calls" : "stop", message: { role: "assistant",
        content: decision ? null : "合成测试结束。", ...(decision ? { tool_calls: [{ id: `repair-${++request}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.arguments) } }] } : {}) } }] }));
    };
    try {
      const result = await runAgent({ task: scenario.task, tools: client.tools,
        model: { baseUrl: "https://repair-eval.invalid/v1", apiKey: "synthetic", model: "trusted-observed-policy" }, modelFetch,
        signal: AbortSignal.any([cancelled.signal, ...(signal ? [signal] : [])]), maxTurns: 16,
        execute: async (name, args, callSignal) => {
          const result = await client.execute(name, args, callSignal);
          const observed = fullObservation(result);
          if (observed && typeof observed.snapshotId === "string") raw.set(observed.snapshotId, structuredClone(observed));
          return result;
        }, onEvent: event => { if (typeof event.errorCode === "string") errors.push(safeDiagnosticErrorCode(event.errorCode)); } });
      results.push(resultFor(scenario, phone.state, result, errors));
    } finally { await client.close(); }
  }
  return results;
}

export type RepairGate = { eligible: boolean; reasons: string[]; baseline: ReturnType<typeof summarize>; candidate: ReturnType<typeof summarize> };
export function gateRepair(incident: RepairIncident, baseline: readonly EvaluationResult[], candidate: readonly EvaluationResult[]): RepairGate {
  const reasons: string[] = [];
  const before = new Map(baseline.map(item => [item.scenarioId, item]));
  const after = new Map(candidate.map(item => [item.scenarioId, item]));
  const expected = generateScenarios();
  if (baseline.length !== expected.length || candidate.length !== expected.length || expected.some(scenario => [before.get(scenario.id), after.get(scenario.id)].some(item =>
    !item || item.mechanism !== scenario.mechanism || item.seed !== scenario.seed || item.suiteVersion !== scenario.suiteVersion || item.split !== scenario.split))) reasons.push("INCOMPLETE_TRUSTED_SUITE");
  if (!baseline.length || baseline.length !== candidate.length || before.size !== baseline.length || after.size !== candidate.length ||
      baseline.some(item => !after.has(item.scenarioId) || after.get(item.scenarioId)?.split !== item.split || after.get(item.scenarioId)?.suiteVersion !== item.suiteVersion)) reasons.push("INCOMPARABLE_RESULTS");
  if (!baseline.some(item => item.split === "holdout") || !baseline.some(item => item.split === "train")) reasons.push("MISSING_SPLIT");
  const old = before.get(incident.scenarioId), fixed = after.get(incident.scenarioId);
  if (!old || old.split !== "train" || old.mechanism !== incident.mechanism || old.verdict !== "failed") reasons.push("BASELINE_NOT_REPRODUCED");
  if (!fixed || fixed.verdict !== "goal") reasons.push("REPRO_NOT_FIXED");
  if (candidate.some(item => item.wrongActions > 0)) reasons.push("WRONG_ACTION");
  if (candidate.some(item => item.falseCompletion)) reasons.push("FALSE_COMPLETION");
  if (candidate.some(item => item.verdict === "unknown")) reasons.push("UNKNOWN_RESULT");
  if (candidate.some(item => ["session_change", "cancel_protected"].includes(item.mechanism) && item.verdict !== "rejected_safe")) reasons.push("SAFETY_NOT_PROVEN");
  if (baseline.some(item => item.verdict === "rejected_safe" && after.get(item.scenarioId)?.verdict !== "rejected_safe")) reasons.push("SAFETY_REGRESSION");
  if (baseline.some(item => item.verdict === "goal" && after.get(item.scenarioId)?.verdict !== "goal")) reasons.push("SUCCESS_REGRESSION");
  return { eligible: reasons.length === 0, reasons, baseline: summarize(baseline), candidate: summarize(candidate) };
}
