import { Adb } from "../adb.js";
import type { DiagnosticEvent } from "../diagnostics/schema.js";
import type { FrozenSnapshot } from "../learning/schema.js";
import { createPhoneClient } from "../client-tools.js";
import { runAgent, type ModelConfig, type ModelFetch } from "../runtime/index.js";
import { resultFor, summarize, type EvaluationResult } from "./report.js";
import { ScenarioPhone, type Json } from "./synthetic-phone.js";
import { SUITE_VERSION, type Scenario } from "./scenarios.js";
export interface Decision { name: string; arguments: Json }
export type FixturePolicy = (observation: Json | undefined, body: Json, scenario: Scenario) => Decision | undefined;
export interface EvaluationOptions { model?: ModelConfig; modelFetch?: ModelFetch; fixturePolicy?: FixturePolicy; signal?: AbortSignal; learningSnapshot?: FrozenSnapshot; onDiagnostic?: (event: DiagnosticEvent) => void; modelFetchDecorator?: (base: ModelFetch) => ModelFetch }
export function currentObservation(body: Json): Json | undefined {
  let latest: Json | undefined;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const object = value as Json;
    if (typeof object.snapshotId === "string" && Array.isArray(object.nodes)) latest = object;
    else for (const child of Object.values(object)) visit(child);
  };
  for (const message of body.messages ?? []) if (message.role === "tool") { try { visit(JSON.parse(message.content)); } catch {} }
  return latest;
}
/** This fixture chooses from observed semantics only; it has no access to endpoint state or future events. */
export const observedPolicy: FixturePolicy = (tree, body, scenario) => {
  const tools = (body.messages ?? []).filter((m: Json) => m.role === "tool").map((m: Json) => m.content).join(" ");
  if (tools.includes("SESSION_CHANGED") || !tree) return;
  const nodes: Json[] = tree.nodes;
  const title = nodes.find(n => n.rid === "id/title");
  if (title?.text === "项目详情") return;
  const action = (kind: string, node: Json, extra: Json = {}): Decision => ({ name: "act_and_observe", arguments: { action: kind, arguments: { snapshotId: tree.snapshotId, nodeId: node.nodeId, ...extra } } });
  const input = nodes.find(n => n.editable);
  if (input) {
    if (!input.focused) return action("tap_element", input);
    if (input.text !== scenario.input) return action("input_text", input, { text: scenario.input });
    const next = nodes.find(n => n.text === "查看项目");
    if (next) return action("tap_element", next);
  }
  const target = nodes.find(n => n.desc === scenario.target || n.text === scenario.target);
  if (target) return action("tap_element", target);
  const list = nodes.find(n => n.scrollable && n.desc === "目标列表");
  if (list) return action("scroll", list, { direction: "forward" });
  if (nodes.some(n => n.text === "正在加载")) return { name: "wait_for_ui_change", arguments: { sinceRevision: tree.revision, timeoutMs: 1000, selector: { text: scenario.target } } };
};
export async function runScenario(scenario: Scenario, options: EvaluationOptions = {}): Promise<EvaluationResult> {
  const phone = new ScenarioPhone(scenario);
  const client = createPhoneClient(phone, new Adb());
  const cancelled = new AbortController();
  const errors: string[] = [];
  let request = 0;
  const fixture: ModelFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const decision = (options.fixturePolicy ?? observedPolicy)(currentObservation(body), body, scenario);
    return new Response(JSON.stringify({ choices: [{ finish_reason: decision ? "tool_calls" : "stop", message: { role: "assistant", content: decision ? null : "合成测试结束。",
      ...(decision ? { tool_calls: [{ id: `eval-${++request}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.arguments) } }] } : {}) } }] }));
  };
  const baseFetch = options.modelFetch ?? (options.model ? globalThis.fetch : fixture);
  const decorated = options.modelFetchDecorator?.(baseFetch) ?? baseFetch;
  const fetch: ModelFetch = async (url, init) => {
    if (scenario.mechanism === "cancel_protected" && scenario.parameters.cancel) { phone.cancel(); cancelled.abort(); }
    return decorated(url, init);
  };
  try {
    const result = await runAgent({ task: scenario.task, tools: client.tools,
      model: options.model ?? { baseUrl: "https://eval.invalid/v1", apiKey: "fixture", model: "observed-policy" }, modelFetch: fetch,
      signal: AbortSignal.any([cancelled.signal, ...(options.signal ? [options.signal] : [])]), maxTurns: 16,
      learningSnapshot: options.learningSnapshot, onDiagnostic: options.onDiagnostic,
      execute: (name, args, signal) => client.execute(name, args, signal),
      onEvent: event => { if (typeof event.errorCode === "string") errors.push(event.errorCode); } });
    return resultFor(scenario, phone.state, result, errors);
  } finally { await client.close(); }
}
export async function runEvaluation(scenarios: readonly Scenario[], options: EvaluationOptions = {}) {
  const results: EvaluationResult[] = [];
  for (const scenario of scenarios) { options.signal?.throwIfAborted(); results.push(await runScenario(scenario, options)); }
  return { schemaVersion: 1 as const, suiteVersion: SUITE_VERSION, mode: options.model ? "model" : "fixture", results, summary: summarize(results) };
}
