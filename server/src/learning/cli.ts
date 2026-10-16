import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DiagnosticStore } from "../diagnostics/store.js";
import { modelFromEnvironment } from "../eval/cli.js";
import { LearningStore } from "./store.js";
import { summarizeCandidates } from "./summarize.js";
import { evaluateCandidate, validationScenarios, EVALUATION_FIXTURE_MODEL } from "./validation.js";
import { modelScope } from "./schema.js";
export interface LearningCliOptions {
  command: "summary" | "list" | "evaluate" | "activate" | "disable" | "rollback";
  root: string; mode: "fixture" | "model"; id?: string; timeoutMs: number; maxTasks: number;
}
export function parseLearningOptions(args: readonly string[]): LearningCliOptions {
  const command = args[0] ?? "summary";
  if (!["summary", "list", "evaluate", "activate", "disable", "rollback"].includes(command)) throw new Error("LEARNING_INVALID_ARGUMENTS");
  const result: LearningCliOptions = { command: command as LearningCliOptions["command"], root: join(homedir(), "Library", "Application Support", "TapPilot"), mode: "fixture", timeoutMs: 600_000, maxTasks: 100 };
  const used = new Set<string>();
  for (let index = args.length ? 1 : 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1];
    if (used.has(flag) || !value || value.startsWith("--")) throw new Error("LEARNING_INVALID_ARGUMENTS");
    used.add(flag);
    switch (flag) {
      case "--root": if (value.length > 4096 || value.includes("\0")) throw new Error("LEARNING_INVALID_ARGUMENTS"); result.root = resolve(value); break;
      case "--id": if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) throw new Error("LEARNING_INVALID_ARGUMENTS"); result.id = value; break;
      case "--mode": if (!["fixture", "model"].includes(value) || !["summary", "evaluate"].includes(command)) throw new Error("LEARNING_INVALID_ARGUMENTS"); result.mode = value as LearningCliOptions["mode"]; break;
      case "--timeout-ms": case "--max-tasks": {
        const limit = flag === "--timeout-ms" ? 3_600_000 : 10_000;
        if (command !== "evaluate" || !/^[1-9]\d*$/.test(value) || Number(value) > limit) throw new Error("LEARNING_INVALID_ARGUMENTS");
        if (flag === "--timeout-ms") result.timeoutMs = Number(value); else result.maxTasks = Number(value);
        break;
      }
      default: throw new Error("LEARNING_INVALID_ARGUMENTS");
    }
  }
  if (["evaluate", "activate", "disable", "rollback"].includes(command) !== !!result.id) throw new Error("LEARNING_INVALID_ARGUMENTS");
  return result;
}
export async function executeLearningCommand(options: LearningCliOptions, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const store = new LearningStore(options.root);
  if (options.command === "list") return { experiences: await store.list() };
  if (options.command === "summary") {
    const diagnostics = new DiagnosticStore({ rootDirectory: options.root });
    const events = await diagnostics.list();
    if (diagnostics.status().storageUnavailable) throw new Error("LEARNING_DIAGNOSTICS_UNAVAILABLE");
    const packageInfo = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const specs = await summarizeCandidates(events, { hostVersion: packageInfo.version,
      ...(options.mode === "model" ? { model: modelFromEnvironment(env) } : modelScope(EVALUATION_FIXTURE_MODEL)) });
    return { experiences: await store.addCandidates(specs) };
  }
  if (options.command === "activate") return { experience: await store.activate(options.id!) };
  if (options.command === "disable" || options.command === "rollback") { await store[options.command](options.id!); return { state: "disabled" }; }
  const entry = (await store.list()).find(candidate => candidate.id === options.id);
  if (!entry || entry.state !== "candidate") throw new Error("LEARNING_NOT_CANDIDATE");
  if (validationScenarios(entry).length * 6 > options.maxTasks) throw new Error("LEARNING_TASK_BUDGET_EXCEEDED");
  const signal = AbortSignal.timeout(options.timeoutMs);
  const model = options.mode === "model" ? modelFromEnvironment(env) : undefined;
  const compared = await evaluateCandidate(entry, { model, signal });
  return { experience: await store.validate(entry.id, compared.evidence) };
}
export async function learningMain(args = process.argv.slice(2), env = process.env): Promise<number> {
  try { const result = await executeLearningCommand(parseLearningOptions(args), env); process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return 0; }
  catch (error) {
    const code = error instanceof Error && /^(LEARNING|EVAL)_[A-Z_]+$/.test(error.message) ? error.message : "LEARNING_FAILED";
    process.stderr.write(JSON.stringify({ error: code }) + "\n"); return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await learningMain();
