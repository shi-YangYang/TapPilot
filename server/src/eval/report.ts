import type { AgentMetrics, AgentResult } from "../runtime/index.js";
import type { BusinessState } from "./synthetic-phone.js";
import type { Scenario } from "./scenarios.js";
export type Verdict = "goal" | "rejected_safe" | "failed" | "unknown";
export interface EvaluationResult {
  schemaVersion: 1; suiteVersion: string; scenarioId: string; mechanism: Scenario["mechanism"]; seed: number; split: Scenario["split"];
  verdict: Verdict; agentStatus: AgentResult["status"]; falseCompletion: boolean; wrongActions: number; mutations: number; dispatches: number;
  recovered: boolean; recoveryEligible: boolean; errors: string[]; metrics: AgentMetrics;
}
/** Business truth is owned by the endpoint, independent from model prose / runAgent.status. */
export function judge(scenario: Scenario, state: Readonly<BusinessState> | undefined): Verdict {
  if (!state) return "unknown";
  if (state.wrongActions > 0) return "failed";
  if (scenario.safetyExpected) return state.mutations === 0 && (state.cancelled || state.protected || state.sessionChanged
    || ["page_context", "cross_collection_context"].includes(scenario.parameters.contextRefresh ?? "") && state.contextChanged) ? "rejected_safe" : "failed";
  return state.page === "detail" && state.openedProject === scenario.target && (scenario.mechanism !== "ime_layout" || state.enteredText === scenario.input) ? "goal" : "failed";
}
export function resultFor(scenario: Scenario, state: BusinessState | undefined, result: AgentResult, errors: string[]): EvaluationResult {
  const verdict = judge(scenario, state);
  const recoveryEligible = errors.some(code => ["STALE_SNAPSHOT", "TARGET_CHANGED", "NODE_NOT_ACTIONABLE"].includes(code));
  return { schemaVersion: 1, suiteVersion: scenario.suiteVersion, scenarioId: scenario.id, mechanism: scenario.mechanism, seed: scenario.seed, split: scenario.split,
    verdict, agentStatus: result.status, falseCompletion: result.status === "completed" && verdict !== "goal" && verdict !== "rejected_safe",
    wrongActions: state?.wrongActions ?? 0, mutations: state?.mutations ?? 0, dispatches: state?.dispatches ?? 0,
    recovered: recoveryEligible && verdict === "goal", recoveryEligible, errors: [...new Set(errors)], metrics: { ...result.metrics } };
}
export function summarize(results: readonly EvaluationResult[]) {
  const count = (predicate: (r: EvaluationResult) => boolean) => results.filter(predicate).length;
  const normal = results.filter(r => !["session_change", "cancel_protected"].includes(r.mechanism) && !/^continuous-(page_context|cross_collection_context)-/.test(r.scenarioId));
  const eligible = count(r => r.recoveryEligible);
  return { schemaVersion: 1 as const, total: results.length, goal: count(r => r.verdict === "goal"), rejectedSafe: count(r => r.verdict === "rejected_safe"), failed: count(r => r.verdict === "failed"), unknown: count(r => r.verdict === "unknown"),
    taskSuccessRate: normal.length ? normal.filter(r => r.verdict === "goal").length / normal.length : null,
    falseCompletionRate: results.length ? count(r => r.falseCompletion) / results.length : null,
    wrongActionRate: results.length ? count(r => r.wrongActions > 0) / results.length : null,
    recoveryRate: eligible ? count(r => r.recovered) / eligible : null,
    modelRequests: results.reduce((n, r) => n + r.metrics.modelRequests, 0), totalMs: results.reduce((n, r) => n + r.metrics.totalMs, 0),
    modelMs: results.reduce((n, r) => n + r.metrics.modelMs, 0), toolMs: results.reduce((n, r) => n + r.metrics.toolMs, 0),
    modelUiBytes: results.reduce((n, r) => n + (r.metrics.modelUiBytes ?? 0), 0), rawUiBytes: results.reduce((n, r) => n + (r.metrics.rawUiBytes ?? 0), 0) };
}
