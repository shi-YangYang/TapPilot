import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions, evaluateSelection, persistReport, modelFromEnvironment, selectedScenarios } from "../src/eval/cli.js";

test("CLI filters and repeats a fixture, saves only aggregate metadata, and refuses invalid budgets/configuration", async () => {
  const options = parseOptions(["--scenario", "fresh_ids-1", "--seed", "1", "--runs", "2", "--max-tasks", "2"]);
  const report = await evaluateSelection(options, { TAPPILOT_EVAL_BASE_URL: "sensitive-endpoint", TAPPILOT_EVAL_MODEL: "sensitive-model", TAPPILOT_EVAL_API_KEY: "sensitive-key", TAPPILOT_EVAL_PROTOCOL: "sensitive-protocol" });
  assert.equal(report.mode, "fixture");
  assert.equal(report.summary.goal, 2);
  assert.equal(report.status, "completed");
  assert.deepEqual(report.results.map(r => r.repetition), [1, 2]);
  assert.equal(JSON.stringify(report).includes("sensitive"), false);
  const directory = await mkdtemp(join(tmpdir(), "tappilot-eval-cli-"));
  try {
    const path = join(directory, "report.json");
    await persistReport(path, report);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), report);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(directory, { force: true, recursive: true }); }
  for (const args of [["--unknown", "sensitive-value"], ["--runs", "0"], ["--seed", "11"], ["--mode", "model", "--mode", "fixture"]]) assert.throws(() => parseOptions(args), { message: "EVAL_INVALID_ARGUMENTS" });
  assert.throws(() => selectedScenarios({ ...options, maxTasks: 1 }), { message: "EVAL_TASK_BUDGET_EXCEEDED" });
  assert.throws(() => modelFromEnvironment({ TAPPILOT_EVAL_PROTOCOL: "sensitive-protocol" }), { message: "EVAL_UNSUPPORTED_PROTOCOL" });
  assert.throws(() => modelFromEnvironment({ TAPPILOT_EVAL_BASE_URL: "sensitive-endpoint" }), { message: "EVAL_MODEL_CONFIG_INVALID" });
  const controller = new AbortController(); controller.abort();
  const stopped = await evaluateSelection(options, {}, { signal: controller.signal });
  assert.equal(stopped.status, "budget_exhausted");
  assert.equal(stopped.attemptedTasks, 0);
});
