import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCandidate, helperSources, gateRepair, runRepair, proposeCandidate, sha256, REPAIR_PATH, type RepairCandidate, type RepairIncident } from "../src/repair/index.js";
import { ProjectionSandbox } from "../src/repair/sandbox.js";
import { generateScenarios } from "../src/eval/scenarios.js";
import type { EvaluationResult } from "../src/eval/report.js";

const source = await readFile(fileURLToPath(new URL("../src/runtime/ui-projection.ts", import.meta.url)), "utf8");
const helpers = helperSources(source);
const incident: RepairIncident = { schemaVersion: 1, actionKind: "tap_element", errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET", count: 3, mechanism: "fresh_ids", scenarioId: "fresh_ids-1" };
function candidate(text = source, sha = "a".repeat(40), content = helpers.meaningful!): RepairCandidate {
  return { schemaVersion: 1, baselineSha: sha, path: REPAIR_PATH, sourceHash: sha256(text), replacements: [{ helper: "meaningful", originalHash: sha256(helperSources(text).meaningful!), content }] };
}
function reports(): EvaluationResult[] {
  return generateScenarios().map(scenario => ({ schemaVersion: 1, suiteVersion: scenario.suiteVersion, scenarioId: scenario.id, mechanism: scenario.mechanism, seed: scenario.seed, split: scenario.split,
    verdict: scenario.safetyExpected ? "rejected_safe" : "goal", agentStatus: "completed", falseCompletion: false, wrongActions: 0, mutations: 0, dispatches: 0, recovered: false, recoveryEligible: false, errors: [],
    metrics: { totalMs: 1, modelMs: 0, toolMs: 1, modelRequests: 1, toolCalls: 1 } }));
}

test("candidate schema blocks path traversal, guarded modules, bad hashes and escaped helper boundaries", () => {
  for (const path of ["../runtime/ui-projection.ts", "server/src/runtime/index.ts", "server/test/eval.test.ts", "AGENTS.md", "server/package.json", "android/app/src/main/AndroidManifest.xml"]) {
    assert.throws(() => applyCandidate(source, { ...candidate(), path }), /INVALID_CANDIDATE/);
  }
  assert.throws(() => applyCandidate(source, { ...candidate(), sourceHash: "b".repeat(64) }), /SOURCE_HASH_MISMATCH/);
  assert.throws(() => applyCandidate(source, { ...candidate(), replacements: [{ helper: "meaningful", originalHash: "b".repeat(64), content: helpers.meaningful }] }), /HELPER_HASH_MISMATCH/);
  assert.throws(() => applyCandidate(source, { ...candidate(), replacements: [{ helper: "actionRejectionReason", originalHash: "b".repeat(64), content: "return null" }] }), /INVALID_CANDIDATE/);
  for (const replacement of ["function meaningful(node: Json) { return true; }\nprojectToolResult = () => ({});", "function meaningful(node: Json) { actionRejectionReasons.clear(); return true; }", "function meaningful(node: Json) { return process.env.API_KEY; }", "function meaningful(node: Json) { return import('node:fs'); }"]) {
    assert.throws(() => applyCandidate(source, candidate(source, undefined, replacement)), /HELPER_BOUNDARY_VIOLATION|HELPER_CAPABILITY_DENIED/);
  }
  const valid = applyCandidate(source, candidate(source, undefined, "function meaningful(node: Json): boolean { return Boolean(node.text) || node.clickable === true; }"));
  assert.equal(valid.source.slice(valid.source.indexOf("const scalarFields")), source.slice(source.indexOf("const scalarFields")));
  assert.equal(valid.candidateHash, sha256(valid.source));
});

test("trusted gate rejects false completion, wrong actions, safety regression, missing holdouts and non-reproducing baselines", () => {
  const baseline = reports(); baseline[0]!.verdict = "failed";
  const fixed = reports();
  assert.equal(gateRepair(incident, baseline, fixed).eligible, true);
  assert.ok(gateRepair(incident, fixed, fixed).reasons.includes("BASELINE_NOT_REPRODUCED"));
  const falseSuccess = structuredClone(fixed); falseSuccess[0]!.falseCompletion = true;
  assert.ok(gateRepair(incident, baseline, falseSuccess).reasons.includes("FALSE_COMPLETION"));
  const wrong = structuredClone(fixed); wrong[0]!.wrongActions = 1;
  assert.ok(gateRepair(incident, baseline, wrong).reasons.includes("WRONG_ACTION"));
  const unsafe = structuredClone(fixed); unsafe.find(item => item.mechanism === "session_change")!.verdict = "goal";
  assert.ok(gateRepair(incident, baseline, unsafe).reasons.includes("SAFETY_NOT_PROVEN"));
  assert.ok(gateRepair(incident, baseline, fixed.filter(item => item.split === "train")).reasons.includes("INCOMPLETE_TRUSTED_SUITE"));
  const regression = structuredClone(fixed); regression[1]!.verdict = "failed";
  assert.ok(gateRepair(incident, baseline, regression).reasons.includes("SUCCESS_REGRESSION"));
});

test("sandbox verifies denied outside reads, network and child processes, then executes only synthetic projection", { skip: process.platform !== "darwin" }, async () => {
  const sandbox = await ProjectionSandbox.create(source, 10_000);
  try {
    assert.throws(() => sandbox.start(), /SANDBOX_STATE/);
    await sandbox.verify(); sandbox.start();
    const output = await sandbox.project({ snapshotId: "synthetic:1", packageName: "synthetic.app", nodes: [{ nodeId: "a", text: "合成按钮", clickable: true }] }) as Record<string, unknown>;
    assert.equal(output.snapshotId, "synthetic:1");
    assert.equal((output.nodes as Array<Record<string, unknown>>)[0]?.text, "合成按钮");
  } finally { await sandbox.close(); }
});

test("sandbox kills a non-terminating candidate within a bounded request deadline", { skip: process.platform !== "darwin" }, async () => {
  const bad = applyCandidate(source, candidate(source, undefined, "function meaningful(node: Json): boolean { while (true) {} }"));
  const sandbox = await ProjectionSandbox.create(bad.source, 10_000);
  const start = performance.now();
  try {
    await sandbox.verify(); sandbox.start();
    await assert.rejects(sandbox.project({ nodes: [{ nodeId: "a", text: "synthetic" }] }), /CANDIDATE_TIMEOUT/);
    assert.ok(performance.now() - start < 8000);
  } finally { await sandbox.close(); }
});

test("isolated repair reproduces a broken helper, evaluates train and holdout through trusted business truth, and emits review artifacts without changing git", { skip: process.platform !== "darwin", timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tappilot-repair-fixture-"));
  const exec = promisify(execFile);
  const git = (args: string[]) => exec("/usr/bin/git", ["-C", directory, ...args], { timeout: 5000, env: { PATH: "/usr/bin:/bin", HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  try {
    await mkdir(join(directory, "server/src/runtime"), { recursive: true });
    const broken = applyCandidate(source, candidate(source, undefined, "function meaningful(node: Json): boolean { return false; }")).source;
    await writeFile(join(directory, REPAIR_PATH), broken);
    await git(["init", "-q"]); await git(["add", "."]); await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "synthetic broken projection"]);
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const artifacts = join(directory, "artifacts"); await mkdir(artifacts);
    const result = await runRepair({ repository: directory, baselineSha: sha, incident, candidates: [candidate(broken, sha)], outputDirectory: artifacts, budgetMs: 90_000 });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.status, "needs_review", JSON.stringify(result[0]));
    assert.equal(result[0]!.gate?.eligible, true);
    assert.equal(result[0]!.gate?.candidate.total, 120);
    assert.equal(result[0]!.applied, false);
    assert.equal(result[0]!.committed, false);
    assert.equal(await readFile(join(directory, REPAIR_PATH), "utf8"), broken);
    assert.equal((await git(["rev-parse", "HEAD"])).stdout.trim(), sha);
    const saved = await readdir(artifacts);
    const patch = await readFile(join(artifacts, saved[0]!, "candidate.patch"), "utf8");
    assert.ok(patch.startsWith(`--- a/${REPAIR_PATH}`));
    // Trusted model generation is opt-in; only allowlisted source and fixed
    // incident metadata are in its prompt, and no token budget override is sent.
    const proposal = await proposeCandidate({ repository: directory, baselineSha: sha, incident,
      model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" }, modelFetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, undefined);
        return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(candidate(broken, sha)) } }] }));
      } });
    assert.deepEqual(proposal, candidate(broken, sha));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
