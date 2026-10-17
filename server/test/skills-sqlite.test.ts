import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SkillStore } from "../src/skills/store.js";
import { SKILL_POLICY_REVISION, skillHash, type SkillSpec } from "../src/skills/schema.js";
import { compactTrace, createEpisode, episodeFingerprint, type FailureEpisode } from "../src/skills/trace.js";
import { type SkillReceipt } from "../src/skills/evaluation.js";
import { startSkillWorker } from "./fixtures/skills-worker-helper.js";

const scope = { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: "a".repeat(64) };
const secret = "PRIVATE-chat-password-验证码";
const observation = { snapshotId: "private:1", sessionId: "private", windowId: 1, packageName: "private.app", truncated: false,
  nodes: [{ nodeId: "private-target", text: secret, clickable: false, enabled: true, visible: true }] };
const diagnostic = { actionKind: "tap_element", errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET",
  dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown" } as const;
function episode(variant = 1) {
  const step = compactTrace({ index: 1, before: observation, after: observation, targetNodeId: "private-target", diagnostic });
  return createEpisode({ scope, trigger: { actionKind: diagnostic.actionKind, errorCode: diagnostic.errorCode, reason: diagnostic.reason },
    steps: [{ ...step, after: { ...step.after, nodeCount: variant } }], termination: "failed", appliedSkillHashes: [] });
}
function candidate(now: number): SkillSpec {
  return { schemaVersion: 1, scope, trigger: episode().trigger, entryConditions: [],
    program: { entry: 0, nodes: [{ kind: "step", operation: { op: "inspect", aspect: "hierarchy" }, next: 1 }, { kind: "end", outcome: "continue" }] },
    lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: now + 86_400_000 };
}
const ledgerFingerprint = (captured: FailureEpisode) => createHash("sha256").update(JSON.stringify([episodeFingerprint(captured), captured.appliedSkillHashes])).digest("hex");
async function withRoot(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "tappilot-skill-sqlite-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function writeLegacy(root: string, value: unknown) {
  const directory = join(root, "skills-v1");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, ".owner"), "TapPilot procedural skills schema 1\n", { mode: 0o600 });
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(join(directory, "state.json"), text, { mode: 0o600 });
  return { directory, text };
}
function legacy(now: number) {
  const captured = episode(), spec = candidate(now), hash = skillHash(spec), jobId = randomUUID();
  // Historical persisted validation metadata only. This fixture is never used
  // as an in-memory adoption receipt; that boundary has a separate test below.
  const validation = { skillHash: hash, episodeHash: episodeFingerprint(captured), modelProfile: scope.modelProfile,
    policyRevision: SKILL_POLICY_REVISION, evaluatorVersion: "structural-recovery-1", hostVersion: scope.hostVersion,
    evaluatedAt: now, evidenceHash: "c".repeat(64), baselineGoals: 0, candidateGoals: 6, baselineRequests: 12, candidateRequests: 6,
    trainApplications: 3, holdoutApplications: 3, caseCount: 24, repetitions: 3, contract: "structural_recovery", incumbentHashes: [] };
  const job = { id: jobId, episodeId: captured.id, fingerprint: ledgerFingerprint(captured), state: "adopted", createdAt: now - 100,
    startedAt: now - 50, finishedAt: now, ownerPid: process.pid, candidateHashes: [hash], feedback: [], modelCalls: 11 };
  return { schemaVersion: 1, enabled: true, episodes: [captured], jobs: [job], skills: [
    { spec, hash, state: "active", jobId, createdAt: now - 25, successes: 2, failures: 0, validation }],
  daily: { day: new Date(now).toISOString().slice(0, 10), jobs: 1, modelCalls: 11 } };
}

test("legacy JSON migrates once without losing history, budgets or frozen task snapshots", async () => withRoot(async root => {
  const now = Date.now(), original = legacy(now), { directory, text } = await writeLegacy(root, original);
  const store = new SkillStore(root);
  assert.deepEqual(await store.status(now), { enabled: true, activeSkills: 1, queued: 0, dailyJobs: 1, dailyModelCalls: 11 });
  assert.deepEqual((await store.history()).jobs, original.jobs);
  assert.deepEqual((await store.history()).skills, original.skills.map(({ hash, state }) => ({ hash, state })));
  const frozen = await store.loadTaskSnapshot(scope, now);
  assert.deepEqual(frozen, [original.skills[0]!.spec]);
  assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(frozen[0]!.program.nodes));
  assert.equal((await readFile(join(directory, "skills.sqlite3"))).subarray(0, 16).toString("utf8"), "SQLite format 3\0");
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), text, "migration preserves the original backup byte-for-byte");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory)) {
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600, name);
  }
  await store.recordUsageOutcome([original.skills[0]!.hash], "failure", now);
  assert.equal((await store.loadTaskSnapshot(scope, now)).length, 0);
  assert.deepEqual(frozen, [original.skills[0]!.spec], "a running task retains the same validated memory snapshot");
  await writeFile(join(directory, "state.json"), '{"noLongerAuthoritative":true}', { mode: 0o600 });
  const restarted = new SkillStore(root);
  assert.equal((await restarted.status(now)).activeSkills, 0, "an old backup cannot resurrect revoked skills");
  assert.equal((await restarted.status(now)).dailyModelCalls, 11);
  assert.equal((await restarted.history()).skills[0]!.state, "revoked");
}));

test("rehearsal candidate evidence reloads validated SQLite records without a legacy JSON file", async () => withRoot(async root => {
  const now = Date.now(), original = legacy(now), { directory } = await writeLegacy(root, original);
  await new SkillStore(root).status(now);
  await rm(join(directory, "state.json"));
  const { candidateEvidence } = await import("../../scripts/skill-learning-rehearsal.mjs");
  const evidence = await candidateEvidence(new SkillStore(root));
  const { hash, state, spec, validation } = original.skills[0]!;
  assert.deepEqual(evidence, [{ hash, state, spec, validation }]);
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence[0].spec.program.nodes));
  await new SkillStore(root).recordUsageOutcome([hash], "failure", now);
  assert.equal((await candidateEvidence(new SkillStore(root)))[0].state, "revoked");
  assert.equal(evidence[0].state, "active", "an exported report remains a fixed evidence snapshot");
  assert.equal((await candidateEvidence(new SkillStore(root)))[0].validation.skillHash, hash);
  await assert.rejects(stat(join(directory, "state.json")), { code: "ENOENT" });
}));

test("post-commit migration recovery seals only the unchanged imported JSON source", async () => {
  for (const changed of [false, true]) await withRoot(async root => {
    const now = Date.now(), original = legacy(now), { directory, text } = await writeLegacy(root, original);
    await new SkillStore(root).status(now);
    const ownerPath = join(directory, ".owner"), sealedOwner = await readFile(ownerPath, "utf8");
    await writeFile(ownerPath, "TapPilot procedural skills schema 1\n", { mode: 0o600 });
    if (changed) {
      await writeFile(join(directory, "state.json"), JSON.stringify({ ...original, enabled: false }), { mode: 0o600 });
      await assert.rejects(new SkillStore(root).status(now), /SKILLS_MIGRATION_CONFLICT/);
      assert.equal(await readFile(ownerPath, "utf8"), "TapPilot procedural skills schema 1\n");
    } else {
      assert.equal((await new SkillStore(root).status(now)).activeSkills, 1);
      assert.equal(await readFile(ownerPath, "utf8"), sealedOwner);
      assert.equal(await readFile(join(directory, "state.json"), "utf8"), text);
    }
  });
});

test("invalid legacy data fails closed and a repaired source can still migrate atomically", async () => {
  const now = Date.now();
  for (const corrupt of [
    () => "{unfinished",
    () => ({ ...legacy(now), apiKey: secret }),
    () => { const state = legacy(now); state.skills[0]!.validation.skillHash = "f".repeat(64); return state; },
    () => { const state = legacy(now); state.jobs.push({ ...state.jobs[0]! }); return state; },
  ]) await withRoot(async root => {
    const value = corrupt(), { directory, text } = await writeLegacy(root, value);
    await assert.rejects(new SkillStore(root).status(now), /SKILLS_INVALID_STORE/);
    assert.equal(await readFile(join(directory, "state.json"), "utf8"), text);
    await assert.rejects(new SkillStore(root).loadTaskSnapshot(scope, now), /SKILLS_INVALID_STORE/);
    const repaired = legacy(now);
    await writeFile(join(directory, "state.json"), JSON.stringify(repaired), { mode: 0o600 });
    const restarted = new SkillStore(root);
    assert.deepEqual((await restarted.history()).jobs, repaired.jobs);
    assert.equal((await restarted.status(now)).activeSkills, 1);
    assert.equal((await restarted.status(now)).dailyModelCalls, 11);
  });
});

test("existing corrupt SQLite is never replaced by an empty or stale JSON state", async () => withRoot(async root => {
  const now = Date.now(), original = legacy(now), { directory, text } = await writeLegacy(root, original);
  await new SkillStore(root).status(now);
  const damaged = "not a SQLite database";
  await writeFile(join(directory, "skills.sqlite3"), damaged, { mode: 0o600 });
  await assert.rejects(new SkillStore(root).status(now), /SKILLS_(?:INVALID_STORE|STORAGE_UNAVAILABLE)/);
  assert.equal(await readFile(join(directory, "skills.sqlite3"), "utf8"), damaged);
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), text);
}));

test("a missing authoritative SQLite database cannot resurrect the old JSON backup", async () => withRoot(async root => {
  const now = Date.now(), original = legacy(now), { directory, text } = await writeLegacy(root, original);
  const store = new SkillStore(root); await store.status(now);
  await store.recordUsageOutcome([original.skills[0]!.hash], "failure", now);
  await rm(join(directory, "skills.sqlite3"));
  await assert.rejects(new SkillStore(root).status(now), /SKILLS_(?:INVALID_STORE|STORAGE_UNAVAILABLE)/);
  await assert.rejects(new SkillStore(root).recordEpisode(episode(2), now), /SKILLS_(?:INVALID_STORE|STORAGE_UNAVAILABLE)/);
  await assert.rejects(stat(join(directory, "skills.sqlite3")), { code: "ENOENT" });
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), text);
}));

test("a sealed SQLite store without a JSON backup cannot silently reinitialize a truncated database", async () => withRoot(async root => {
  const store = new SkillStore(root); await store.recordEpisode(episode());
  const path = join(store.directory, "skills.sqlite3"), owner = await readFile(join(store.directory, ".owner"), "utf8");
  await assert.rejects(stat(join(store.directory, "state.json")), { code: "ENOENT" });
  await writeFile(path, Buffer.alloc(0), { mode: 0o600 });
  await assert.rejects(new SkillStore(root).status(), /SKILLS_INVALID_STORE/);
  await assert.rejects(new SkillStore(root).recordEpisode(episode(2)), /SKILLS_INVALID_STORE/);
  assert.equal((await stat(path)).size, 0, "failed reads/writes must not initialize an empty replacement store");
  assert.equal(await readFile(join(store.directory, ".owner"), "utf8"), owner);
}));

test("SQLite database and sidecar paths reject symlinks and hard links before touching outside files", async () => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) for (const makeLink of [symlink, link]) await withRoot(async root => {
    const store = new SkillStore(root); await store.recordEpisode(episode());
    const outside = join(root, "outside"), target = join(store.directory, `skills.sqlite3${suffix}`), original = "outside-must-stay-unchanged";
    await writeFile(outside, original, { mode: 0o600 });
    await rm(target, { force: true }); await makeLink(outside, target);
    await assert.rejects(store.status(), /SKILLS_UNSAFE_STORAGE/);
    assert.equal(await readFile(outside, "utf8"), original);
  });
});

test("SQLite keeps sanitized evidence private and cannot turn serialized proof into an adoption receipt", async () => withRoot(async root => {
  const now = Date.now(), store = new SkillStore(root), captured = episode();
  await assert.rejects(store.recordEpisode({ ...captured, task: secret }), /SKILLS_INVALID_EPISODE/);
  const queued = await store.recordEpisode(captured); assert.ok(await store.beginJob(scope.modelProfile));
  const spec = candidate(now), hash = await store.addCandidate(queued.id, spec);
  await assert.rejects(store.adopt(queued.id, hash, legacy(now).skills[0]!.validation as unknown as SkillReceipt), /SKILLS_UNTRUSTED_RECEIPT/);
  assert.equal((await store.loadSnapshot(scope)).length, 0);
  assert.equal((await store.history()).jobs[0]!.state, "running");
  assert.equal((await store.history()).skills[0]!.state, "candidate");
  for (const name of await readdir(store.directory)) {
    const bytes = await readFile(join(store.directory, name));
    assert.equal(bytes.includes(Buffer.from(secret)), false, name);
    assert.equal(bytes.includes(Buffer.from("private.app")), false, name);
    assert.equal((await stat(join(store.directory, name))).mode & 0o777, 0o600, name);
  }
}));

test("concurrent processes claim only one queued job while the winning owner is alive", { timeout: 20_000 }, async () => withRoot(async root => {
  const now = Date.now(), store = new SkillStore(root);
  await store.recordEpisode(episode(1), now); await store.recordEpisode(episode(2), now);
  const workers = await Promise.all(Array.from({ length: 4 }, () => startSkillWorker(root, "claim", { modelProfile: scope.modelProfile, now })));
  try {
    const claims = await Promise.all(workers.map(worker => worker.run()));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await store.status(now)).dailyJobs, 1);
    assert.equal((await store.history()).jobs.filter(job => job.state === "running").length, 1);
    assert.equal((await store.status(now)).queued, 1);
  } finally { await Promise.all(workers.map(worker => worker.kill())); }
}));

test("connection setup waits for a transient exclusive database lock without losing the job", { timeout: 20_000 }, async () => withRoot(async root => {
  const now = Date.now(), store = new SkillStore(root), queued = await store.recordEpisode(episode(), now);
  const worker = await startSkillWorker(root, "claim", { modelProfile: scope.modelProfile, now });
  const lock = new DatabaseSync(join(store.directory, "skills.sqlite3"));
  let closed = false;
  try {
    lock.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    const outcome = worker.run().then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setTimeout(resolve, 100));
    lock.exec("COMMIT"); lock.close(); closed = true;
    const result = await outcome;
    if ("error" in result) throw result.error;
    assert.equal(result.value.id, queued.id);
    assert.equal((await store.status(now)).dailyJobs, 1);
  } finally { if (!closed) lock.close(); await worker.kill(); }
}));

test("concurrent process reservations cannot overrun the daily model-call budget", { timeout: 20_000 }, async () => withRoot(async root => {
  const now = Date.now(), state = legacy(now), secondEpisode = episode(2), secondId = randomUUID();
  state.jobs[0]!.modelCalls = 150;
  state.jobs.push({ id: secondId, episodeId: secondEpisode.id, fingerprint: ledgerFingerprint(secondEpisode), state: "running", createdAt: now,
    startedAt: now, ownerPid: process.pid, candidateHashes: [], feedback: [], modelCalls: 40 } as typeof state.jobs[number]);
  state.episodes.push(secondEpisode); state.daily = { ...state.daily, jobs: 2, modelCalls: 190 };
  await writeLegacy(root, state);
  const store = new SkillStore(root); assert.equal((await store.status(now)).dailyModelCalls, 190);
  const workers = await Promise.all(Array.from({ length: 4 }, () => startSkillWorker(root, "reserve", { jobId: secondId, calls: 5, now })));
  try {
    const outcomes = await Promise.all(workers.map(worker => worker.run()));
    assert.equal(outcomes.reduce((sum, outcome) => sum + outcome.reserved, 0), 10);
    assert.deepEqual(outcomes.flatMap(outcome => outcome.errors), Array(10).fill("SKILLS_BUDGET_EXHAUSTED"));
    assert.equal((await new SkillStore(root).status(now)).dailyModelCalls, 200);
    assert.deepEqual((await store.history()).jobs.map(job => job.modelCalls), [150, 50]);
  } finally { await Promise.all(workers.map(worker => worker.kill())); }
}));
