import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { endpointFor, type ModelConfig } from "../runtime/model.js";
import { generateScenarios, SUITE_VERSION, type Scenario, type Split } from "./scenarios.js";
import { runScenario, type EvaluationOptions } from "./runner.js";
import { summarize, type EvaluationResult } from "./report.js";

export interface CliOptions {
  split: Split | "all"; mode: "fixture" | "model"; output?: string; runs: number;
  scenario?: string; seed?: number; maxTasks: number; timeoutMs: number;
}
class CliError extends Error { constructor(readonly code: string) { super(code); } }
const badArgs = () => new CliError("EVAL_INVALID_ARGUMENTS");
export function parseOptions(args: readonly string[]): CliOptions {
  const result: CliOptions = { split: "train", mode: "fixture", runs: 1, maxTasks: 500, timeoutMs: 600_000 };
  const used = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (used.has(name) || !value || value.startsWith("--")) throw badArgs();
    used.add(name);
    const integer = (maximum: number) => {
      if (!/^[1-9]\d*$/.test(value)) throw badArgs();
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number > maximum) throw badArgs();
      return number;
    };
    switch (name) {
      case "--split": if (!["train", "holdout", "all"].includes(value)) throw badArgs(); result.split = value as CliOptions["split"]; break;
      case "--mode": if (!["fixture", "model"].includes(value)) throw badArgs(); result.mode = value as CliOptions["mode"]; break;
      case "--output": if (value.includes("\0") || value.length > 4096) throw badArgs(); result.output = resolve(value); break;
      case "--runs": result.runs = integer(100); break;
      case "--scenario": if (!/^[a-z_]+-[1-9]\d*$/.test(value)) throw badArgs(); result.scenario = value; break;
      case "--seed": result.seed = integer(10); break;
      case "--max-tasks": result.maxTasks = integer(10_000); break;
      case "--timeout-ms": result.timeoutMs = integer(3_600_000); break;
      default: throw badArgs();
    }
  }
  return result;
}
export function selectedScenarios(options: CliOptions): Scenario[] {
  const selected = generateScenarios(options.split === "all" ? {} : { split: options.split })
    .filter(s => (!options.scenario || s.id === options.scenario) && (!options.seed || s.seed === options.seed));
  if (!selected.length) throw new CliError("EVAL_EMPTY_SELECTION");
  if (selected.length * options.runs > options.maxTasks) throw new CliError("EVAL_TASK_BUDGET_EXCEEDED");
  return selected;
}
export function modelFromEnvironment(env: NodeJS.ProcessEnv): ModelConfig {
  const protocol = env.TAPPILOT_EVAL_PROTOCOL ?? "openai-chat-completions";
  if (protocol !== "openai-chat-completions") throw new CliError("EVAL_UNSUPPORTED_PROTOCOL");
  const model = { baseUrl: env.TAPPILOT_EVAL_BASE_URL ?? "", model: env.TAPPILOT_EVAL_MODEL ?? "", apiKey: env.TAPPILOT_EVAL_API_KEY ?? "" };
  try { endpointFor(model); } catch { throw new CliError("EVAL_MODEL_CONFIG_INVALID"); }
  return model;
}
export interface PersistentReport {
  schemaVersion: 1; suiteVersion: string; mode: "fixture" | "model"; split: CliOptions["split"];
  status: "completed" | "budget_exhausted"; plannedTasks: number; attemptedTasks: number; repetitions: number;
  results: (EvaluationResult & { repetition: number })[]; summary: ReturnType<typeof summarize>;
}
export async function evaluateSelection(options: CliOptions, env: NodeJS.ProcessEnv = process.env,
  dependencies: { run?: typeof runScenario; signal?: AbortSignal } = {}): Promise<PersistentReport> {
  const scenarios = selectedScenarios(options);
  // Fixture mode never reads model configuration and cannot enable a network model implicitly.
  const model = options.mode === "model" ? modelFromEnvironment(env) : undefined;
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([deadline, ...(dependencies.signal ? [dependencies.signal] : [])]);
  const results: PersistentReport["results"] = [];
  const execute = dependencies.run ?? runScenario;
  for (let repetition = 1; repetition <= options.runs; repetition++) {
    for (const scenario of scenarios) {
      if (signal.aborted) break;
      const settings: EvaluationOptions = { signal, ...(model ? { model } : {}) };
      const result = await execute(scenario, settings);
      results.push({ ...result, repetition });
    }
    if (signal.aborted) break;
  }
  return { schemaVersion: 1, suiteVersion: SUITE_VERSION, mode: options.mode, split: options.split,
    status: signal.aborted ? "budget_exhausted" : "completed", plannedTasks: scenarios.length * options.runs,
    attemptedTasks: results.length, repetitions: options.runs, results, summary: summarize(results) };
}
export async function persistReport(path: string, report: PersistentReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function main(args = process.argv.slice(2), env = process.env): Promise<number> {
  try {
    const options = parseOptions(args);
    const report = await evaluateSelection(options, env);
    if (options.output) await persistReport(options.output, report);
    // Deliberately exclude user-provided paths, configuration and model responses from output.
    process.stdout.write(JSON.stringify({ status: report.status, plannedTasks: report.plannedTasks, attemptedTasks: report.attemptedTasks, summary: report.summary }) + "\n");
    return report.status !== "completed" || report.summary.failed > 0 || report.summary.unknown > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof CliError ? error.code : "EVAL_FAILED" }) + "\n");
    return 2;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
