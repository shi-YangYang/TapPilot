import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticStore } from "../src/diagnostics/store.js";
import { createDiagnosticRunId, type DiagnosticEvent } from "../src/diagnostics/schema.js";
import { LearningStore, summarizeCandidates, candidateEvaluationPolicy, modelScope, EVALUATION_FIXTURE_MODEL } from "../src/learning/index.js";
import { executeLearningCommand, parseLearningOptions } from "../src/learning/cli.js";

test("learning CLI executes real fixture comparisons, refuses no-improvement activation, and deduplicates expiry-independent candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "tappilot-learning-cli-"));
  try {
    const now = Date.now();
    const event: DiagnosticEvent = { schemaVersion: 1, eventType: "tool_result", runId: createDiagnosticRunId(), timestamp: now, stepIndex: 1,
      actionKind: "tap_element", outcome: "failure", failureStage: "phone_validation", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown",
      errorCode: "STALE_SNAPSHOT", reason: "UNKNOWN", versions: { host: "0.3.19" } };
    const diagnostics = new DiagnosticStore({ rootDirectory: root });
    assert.equal((await diagnostics.append(event)).stored, true);
    const command = (name: string, extra: string[] = []) => parseLearningOptions([name, "--root", root, ...extra]);
    await executeLearningCommand(command("summary"), { TAPPILOT_EVAL_BASE_URL: "secret", TAPPILOT_EVAL_API_KEY: "secret" });
    const store = new LearningStore(root), [first] = await store.list(); assert.ok(first);
    await store.addCandidates(await summarizeCandidates([event], { hostVersion: "0.3.19", ...modelScope(EVALUATION_FIXTURE_MODEL), now: now + 1000 }), now + 1000);
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.list())[0]!.spec.expiresAt, first.spec.expiresAt, "Recurrence must not extend validity");
    await assert.rejects(executeLearningCommand(command("activate", ["--id", first.id])), /LEARNING_NOT_VALIDATED/);
    await assert.rejects(executeLearningCommand(command("evaluate", ["--id", first.id])), /LEARNING_CANDIDATE_NOT_APPLIED/);
    assert.equal((await store.list())[0]!.state, "candidate");
    const adapter = candidateEvaluationPolicy(first.spec);
    let hintRequests = 0;
    const fetch = adapter.modelFetchDecorator(async (_url, init) => {
      if (String(init.body).includes("Validated local recovery advice")) hintRequests++;
      return new Response("{}");
    });
    adapter.onDiagnostic(event);
    adapter.onDiagnostic({ ...event, actionKind: "get_ui_tree", outcome: "success", errorCode: "NONE" });
    const request = { body: JSON.stringify({ messages: [{ role: "system", content: "policy" }] }) };
    await fetch("https://fixture.invalid/", request); await fetch("https://fixture.invalid/", request);
    assert.equal(hintRequests, 1, "A successful host read preserves failure guidance; the next request consumes it once");
    await executeLearningCommand(command("disable", ["--id", first.id]));
    await executeLearningCommand(command("rollback", ["--id", first.id]));
    assert.equal((await store.list())[0]!.state, "disabled");
    const later = first.spec.expiresAt + 1;
    await store.addCandidates(await summarizeCandidates([event], { hostVersion: "0.3.19", ...modelScope(EVALUATION_FIXTURE_MODEL), now: later }), later);
    assert.equal((await store.list()).length, 2, "An expired semantic entry can create a fresh candidate, never reactivate itself");
    assert.throws(() => parseLearningOptions(["evaluate", "--import", "passed.json"]), /LEARNING_INVALID_ARGUMENTS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
