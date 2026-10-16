import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, unlink, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LearningStore, modelScope, summarizeCandidates, candidateHash, type CandidateSpec, type Experience } from "../src/learning/index.js";
import { createDiagnosticRunId, type DiagnosticEvent } from "../src/diagnostics/schema.js";

const model = { baseUrl: "https://model.example/v1", model: "deepseek-synthetic", apiKey: "synthetic-key" };
const diagnostic = (): DiagnosticEvent => ({ schemaVersion: 1, eventType: "tool_result", runId: createDiagnosticRunId(), timestamp: Date.now(), stepIndex: 1,
  actionKind: "tap_element", outcome: "failure", failureStage: "host_validation", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown",
  errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET", versions: { host: "0.3.19" } });
async function spec() { return (await summarizeCandidates([diagnostic()], { hostVersion: "0.3.19", ...modelScope(model) }))[0]!; }
async function fixtureStore(work: (store: LearningStore, root: string, candidate: CandidateSpec) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "tappilot-learning-scope-"));
  try { const store = new LearningStore(root), candidate = await spec(); await store.addCandidates([candidate]); await work(store, root, candidate); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("exact model profiles canonicalize endpoints, ignore keys, and keep model/provider identity private", async () => {
  const scope = modelScope(model);
  assert.equal(scope.modelFamily, "deepseek");
  assert.match(scope.modelProfile, /^[a-f0-9]{64}$/);
  assert.deepEqual(scope, modelScope({ ...model, baseUrl: "https://MODEL.EXAMPLE:443/v1/chat/completions/", model: " deepseek-synthetic ", apiKey: "rotated-key" }));
  assert.notEqual(scope.modelProfile, modelScope({ ...model, baseUrl: "https://different.example/v1" }).modelProfile);
  assert.notEqual(scope.modelProfile, modelScope({ ...model, model: "deepseek-other" }).modelProfile);
  assert.equal(modelScope({ ...model, baseUrl: "http://localhost:1234/v1" }).modelFamily, "local");
  let requests = 0;
  const candidates = await summarizeCandidates([diagnostic()], { hostVersion: "0.3.19", model, modelFetch: async () => {
    requests++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"proposals":[{"group":0,"strategy":"choose_actionable_ancestor"}]}' } }] }));
  } });
  assert.deepEqual(candidates[0]!.scope, { hostVersion: "0.3.19", ...scope });
  assert.equal(requests, 1);
  for (const value of [model.baseUrl, model.model, model.apiKey]) assert.equal(JSON.stringify(candidates).includes(value), false);
  await assert.rejects(summarizeCandidates([diagnostic()], { hostVersion: "0.3.19", model, modelProfile: "0".repeat(64), modelFetch: async () => { requests++; throw new Error(); } }), /LEARNING_MODEL_SCOPE_MISMATCH/);
  assert.equal(requests, 1, "An inconsistent profile must fail before requesting a model");
});

test("persisted legacy and exact-profile entries cannot activate or load outside their validated model", async () => fixtureStore(async (store, _root, candidate) => {
  // Seed persisted validated records to exercise compatibility/filtering only.
  // Actual evidence validation is covered by the paired evaluation tests.
  const record = (value: CandidateSpec, state: Experience["state"]): Experience => ({
    id: randomUUID(), spec: value, state, createdAt: Date.now(), successes: 0, failures: 0,
    validation: { candidateHash: candidateHash(value), suiteVersion: "native-state-machine-1", evidenceHash: "a".repeat(64),
      cases: ["clickable_parent-1"], evaluatedAt: Date.now(), baselineGoals: 0, candidateGoals: 1, baselineRequests: 2, candidateRequests: 1,
      improvement: "goals", repetitions: 3, trainApplications: 3, holdoutApplications: 3, improvedAppliedCases: ["clickable_parent-1", "clickable_parent-8"] },
  });
  const legacy = record({ ...candidate, scope: { hostVersion: "0.3.19", modelFamily: "deepseek" } }, "validated");
  const scoped = record(candidate, "validated");
  await writeFile(join(store.directory, "experiences.json"), JSON.stringify([legacy, scoped]), { mode: 0o600 });
  await assert.rejects(store.activate(legacy.id), /LEARNING_MODEL_SCOPE_REQUIRED/);
  await store.activate(scoped.id);
  const scope = modelScope(model);
  assert.equal((await store.loadActive("0.3.19", scope.modelFamily, undefined, scope.modelProfile)).length, 1);
  assert.equal((await store.loadActive("0.3.19", scope.modelFamily)).length, 0);
  assert.equal((await store.loadActive("0.3.19", scope.modelFamily, undefined, modelScope({ ...model, model: "deepseek-other" }).modelProfile)).length, 0);
  assert.equal((await store.loadActive("0.3.19", "openai", undefined, scope.modelProfile)).length, 0);
}));

test("a live writer is never stolen, but its complete owner record is recovered after actual process death", { timeout: 10_000 }, async () => fixtureStore(async (store, _root, candidate) => {
  const path = join(store.directory, ".write-lock");
  const child = spawn(process.execPath, ["-e", `const fs=require('node:fs'); const c=require('node:crypto'); fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,token:c.randomUUID()}),{flag:'wx',mode:0o600}); process.stdout.write('ready'); setInterval(()=>{},1000);`, path], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    const owner = await readFile(path, "utf8");
    assert.equal(JSON.parse(owner).pid, child.pid);
    await assert.rejects(store.addCandidates([candidate]), /LEARNING_LOCK_BUSY/);
    assert.equal(await readFile(path, "utf8"), owner);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    // Emulate a crash between atomic hard-link publication and temp cleanup too.
    await link(path, join(store.directory, ".lock-publish-crashed.tmp"));
    await store.addCandidates([candidate]);
    assert.equal((await store.list()).length, 1);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}));

test("recovery ownership must match PID and token and cannot follow a symlink", { timeout: 10_000 }, async () => fixtureStore(async (store, root, candidate) => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid!; await once(child, "exit");
  const token = randomUUID(), claim = join(store.directory, `.write-recovery-${deadPid}-${token}`);
  await writeFile(claim, JSON.stringify({ pid: deadPid, token }), { mode: 0o600 });
  await store.addCandidates([candidate]);
  await assert.rejects(readFile(claim), { code: "ENOENT" });
  const liveToken = randomUUID(), liveClaim = join(store.directory, `.write-recovery-${process.pid}-${liveToken}`);
  await writeFile(liveClaim, JSON.stringify({ pid: process.pid, token: liveToken }), { mode: 0o600 });
  await assert.rejects(store.addCandidates([candidate]), /LEARNING_LOCK_BUSY/);
  await unlink(liveClaim);
  await writeFile(claim, JSON.stringify({ pid: deadPid, token: randomUUID() }), { mode: 0o600 });
  await assert.rejects(store.addCandidates([candidate]), /LEARNING_UNSAFE_LOCK/);
  await unlink(claim);
  const outside = join(root, "unrelated.json"), original = JSON.stringify({ pid: deadPid, token });
  await writeFile(outside, original, { mode: 0o600 });
  await symlink(outside, join(store.directory, ".write-lock"));
  await assert.rejects(store.addCandidates([candidate]), /LEARNING_UNSAFE_LOCK/);
  assert.equal(await readFile(outside, "utf8"), original);
}));
