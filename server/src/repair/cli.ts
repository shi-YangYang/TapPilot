import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { baselineSource, helperSources } from "./candidate.js";
import { runRepair, proposeCandidate } from "./pipeline.js";
import { IncidentSchema, sha256, repairCode, RepairError, REPAIR_PATH } from "./schema.js";

async function json(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 128 * 1024) throw new RepairError("INPUT_LIMIT"); return JSON.parse(await handle.readFile("utf8")); }
  finally { await handle.close(); }
}
async function main() {
  const args = process.argv.slice(2), command = args.shift();
  if (!["prepare", "evaluate", "propose"].includes(command ?? "")) throw new RepairError("USAGE");
  const flags = new Map<string, string[]>();
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (!["--repo", "--baseline", "--incident", "--candidate", "--out", "--budget-ms"].includes(flag) || !value || flag !== "--candidate" && flags.has(flag)) throw new RepairError("USAGE");
    flags.set(flag, [...flags.get(flag) ?? [], value]);
  }
  const repository = flags.get("--repo")?.[0], baselineSha = flags.get("--baseline")?.[0];
  if (!repository || !baselineSha) throw new RepairError("USAGE");
  if (command === "prepare") {
    const source = await baselineSource(repository, baselineSha), helpers = helperSources(source);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, baselineSha, path: REPAIR_PATH, sourceHash: sha256(source), replacements: [{ helper: "meaningful", originalHash: sha256(helpers.meaningful!), content: helpers.meaningful }] }, null, 2) + "\n");
    return;
  }
  const incidentFile = flags.get("--incident")?.[0];
  if (!incidentFile) throw new RepairError("USAGE");
  const incident = IncidentSchema.parse(await json(incidentFile));
  if (command === "propose") {
    const { TAPPILOT_MODEL_BASE_URL: baseUrl, TAPPILOT_MODEL_KEY: apiKey, TAPPILOT_MODEL_NAME: model } = process.env;
    if (!baseUrl || !apiKey || !model) throw new RepairError("MODEL_NOT_CONFIGURED");
    const candidate = await proposeCandidate({ repository, baselineSha, incident, model: { baseUrl, apiKey, model } });
    process.stdout.write(JSON.stringify(candidate, null, 2) + "\n");
    return;
  }
  const files = flags.get("--candidate") ?? [];
  if (!files.length || files.length > 3) throw new RepairError("CANDIDATE_BUDGET");
  const reports = await runRepair({ repository, baselineSha, incident, candidates: await Promise.all(files.map(json)),
    outputDirectory: flags.get("--out")?.[0], budgetMs: Number(flags.get("--budget-ms")?.[0] ?? 60_000) });
  process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  if (reports.some(report => report.status !== "needs_review")) process.exitCode = 1;
}
void main().catch(error => { process.stderr.write(JSON.stringify({ error: repairCode(error), usage: "repair prepare|evaluate|propose --repo PATH --baseline SHA [--incident JSON --candidate JSON --out EXISTING_DIR --budget-ms 60000]" }) + "\n"); process.exitCode = 1; });
