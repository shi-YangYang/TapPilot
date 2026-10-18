import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SkillStore } from "../src/skills/store.js";
import { SKILL_POLICY_REVISION, skillHash, type SkillSpec } from "../src/skills/schema.js";
import { compactTrace, createEpisode } from "../src/skills/trace.js";
import type { SkillReceipt } from "../src/skills/evaluation.js";

const scope = { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: "a".repeat(64) };
const trigger = { actionKind: "tap_element", errorCode: "NODE_NOT_ACTIONABLE", reason: "NO_CLICKABLE_TARGET" } as const;
function spec(): SkillSpec { return { schemaVersion: 1, scope, trigger, entryConditions: [], program: { entry: 0, nodes: [
  { kind: "step", operation: { op: "inspect", aspect: "hierarchy" }, next: 1 }, { kind: "end", outcome: "continue" } ] },
  lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 86_400_000 }; }
function episode(nodeCount = 1, appDigest?: string) {
  const observation = { snapshotId: "fixture:1", sessionId: "fixture", windowId: 1, packageName: "fixture.app", truncated: false, nodes: [{ nodeId: "target", clickable: false, enabled: true, visible: true }] };
  const step = compactTrace({ index: 1, before: observation, after: observation, targetNodeId: "target", diagnostic: { ...trigger, dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown" } });
  return createEpisode({ scope: { ...scope, ...(appDigest ? { appDigest } : {}) }, trigger,
    steps: [{ ...step, after: { ...step.after, nodeCount } }], termination: "failed", appliedSkillHashes: [] });
}
async function withStore(work: (store: SkillStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "tappilot-managed-skills-"));
  try { await work(new SkillStore(root), root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("manual CRUD persists drafts, isolates names and rejects privileges or scope changes", async () => withStore(async (store, root) => {
  const input = { title: "按钮恢复", spec: spec() };
  const created = await store.createManagedSkill(input);
  assert.equal(created.state, "draft"); assert.equal(created.source, "manual");
  assert.equal((await store.loadTaskSnapshot(scope)).length, 0);
  assert.equal((await store.status()).queued, 0);
  const reloaded = new SkillStore(root);
  assert.deepEqual(await reloaded.listManagedSkills(), [created]);
  const renamed = await reloaded.updateManagedSkill(created.id, { ...input, title: "恢复当前目标" });
  assert.equal(renamed.id, created.id); assert.equal(renamed.title, "恢复当前目标");
  assert.deepEqual(renamed.spec, input.spec); assert.equal(renamed.state, "draft");
  await assert.rejects(store.createManagedSkill({ ...input, state: "active", validation: {} } as any), /SKILLS_INVALID_MANAGED_SKILL/);
  await assert.rejects(store.createManagedSkill({ ...input, title: "x".repeat(81) }), /SKILLS_INVALID_MANAGED_SKILL/);
  await assert.rejects(store.createManagedSkill(input), /SKILLS_DUPLICATE_CANDIDATE/);
  await assert.rejects(store.updateManagedSkill(created.id, { ...input, spec: { ...input.spec, scope: { ...scope, modelProfile: "b".repeat(64) } } }), /SKILLS_INVALID_MANAGED_SKILL/);
  await store.deleteManagedSkill(created.id);
  assert.deepEqual(await reloaded.listManagedSkills(), []);
  await assert.rejects(store.deleteManagedSkill(created.id), /SKILLS_NOT_FOUND/);
}));

test("manual drafts bind to actual app evidence and resume only never-dispatched queued tests", async () => withStore(async store => {
  const draft = await store.createManagedSkill({ title: "待验证", spec: spec() });
  const captured = episode(1, "b".repeat(64));
  await store.recordEpisode(captured);
  assert.equal((await store.status()).queued, 1);
  assert.equal((await store.listManagedSkills())[0]!.spec.scope.appDigest, captured.scope.appDigest);
  await store.setEnabled(false); assert.equal((await store.status()).queued, 0);
  await store.setEnabled(true); assert.equal((await store.status()).queued, 1);
  const claimed = await store.beginJob(scope.modelProfile);
  assert.ok(claimed?.candidate); assert.equal(claimed.candidate.hash, skillHash(claimed.candidate.spec));
  assert.deepEqual(claimed.candidate.spec.scope, captured.scope);
  assert.equal((await store.listManagedSkills())[0]!.id, draft.id);
  await assert.rejects(store.adopt(claimed.job.id, claimed.candidate.hash, {} as SkillReceipt), /SKILLS_UNTRUSTED_RECEIPT/);
  assert.equal((await store.loadTaskSnapshot(scope)).length, 0);
  await store.finishJob(claimed.job.id, "interrupted");
  await store.setEnabled(false); await store.setEnabled(true);
  assert.equal((await store.status()).queued, 0, "already dispatched tests never replay after a toggle");
}));

test("historical failures can evaluate new drafts and edits/deletes invalidate in-flight candidates", async () => withStore(async store => {
  const captured = episode(), recorded = await store.recordEpisode(captured);
  await store.beginJob(scope.modelProfile); await store.finishJob(recorded.id, "rejected");
  const initial = await store.createManagedSkill({ title: "第一次", spec: spec() });
  const first = await store.beginJob(scope.modelProfile); assert.ok(first?.candidate);
  const changed: SkillSpec = { ...initial.spec, program: { entry: 0, nodes: [{ kind: "step", operation: { op: "inspect", aspect: "context" }, next: 1 }, { kind: "end", outcome: "continue" }] } };
  const edited = await store.updateManagedSkill(initial.id, { title: "第二次", spec: changed });
  assert.equal(edited.state, "draft"); assert.equal(edited.id, initial.id);
  await assert.rejects(store.adopt(first.job.id, first.candidate.hash, {} as SkillReceipt), /SKILLS_NOT_CANDIDATE/);
  await assert.rejects(store.reserveModelCall(first.job.id), /SKILLS_JOB_CANCELLED/);
  const second = await store.beginJob(scope.modelProfile); assert.ok(second?.candidate);
  await store.deleteManagedSkill(initial.id);
  await assert.rejects(store.adopt(second.job.id, second.candidate.hash, {} as SkillReceipt), /SKILLS_NOT_CANDIDATE/);
  assert.deepEqual(await store.listManagedSkills(), []);
}));

test("automatic skills are visible and editable, with title-only edits preserving their state", async () => withStore(async store => {
  const queued = await store.recordEpisode(episode()); await store.beginJob(scope.modelProfile);
  const initial = spec(), hash = await store.addCandidate(queued.id, initial);
  const automatic = (await store.listManagedSkills())[0]!;
  assert.equal(automatic.source, "automatic"); assert.equal(automatic.id, hash);
  const renamed = await store.updateManagedSkill(hash, { title: "自动生成的恢复", spec: initial });
  assert.equal(renamed.source, "automatic"); assert.equal(renamed.state, "candidate");
  assert.equal((await store.listManagedSkills()).length, 1);
  const edited = await store.updateManagedSkill(hash, { title: "改为检查上下文", spec: { ...initial, program: { entry: 0, nodes: [
    { kind: "step", operation: { op: "inspect", aspect: "context" }, next: 1 }, { kind: "end", outcome: "stop" } ] } } });
  assert.equal(edited.source, "manual"); assert.equal(edited.state, "draft");
  await assert.rejects(store.adopt(queued.id, hash, {} as SkillReceipt), /SKILLS_NOT_CANDIDATE/);
  await store.deleteManagedSkill(hash); assert.deepEqual(await store.listManagedSkills(), []);
}));

test("SQLite schema 1 migrates without losing evidence and removes both daily checks", async () => withStore(async (store, root) => {
  const queued = await store.recordEpisode(episode()); await store.beginJob(scope.modelProfile);
  await store.addCandidate(queued.id, spec()); await store.finishJob(queued.id, "rejected");
  const history = await store.history();
  const old = new DatabaseSync(join(store.directory, "skills.sqlite3"));
  try { old.exec(`BEGIN IMMEDIATE; DROP TABLE managed_skills; ALTER TABLE metadata RENAME TO metadata_new;
    CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
    enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),daily_day TEXT NOT NULL,daily_jobs INTEGER NOT NULL CHECK(daily_jobs BETWEEN 0 AND 2),
    daily_model_calls INTEGER NOT NULL CHECK(daily_model_calls BETWEEN 0 AND 200),legacy_sha256 TEXT) STRICT;
    INSERT INTO metadata SELECT id,1,enabled,daily_day,2,200,legacy_sha256 FROM metadata_new;
    DROP TABLE metadata_new; PRAGMA user_version=1; COMMIT;`); } finally { old.close(); }
  const migrated = new SkillStore(root);
  assert.deepEqual(await migrated.history(), history);
  const next = await migrated.recordEpisode(episode(2)); assert.ok(await migrated.beginJob(scope.modelProfile));
  await migrated.reserveModelCall(next.id);
  assert.equal((await migrated.status()).dailyJobs, 3); assert.equal((await migrated.status()).dailyModelCalls, 201);
  const check = new DatabaseSync(join(store.directory, "skills.sqlite3"));
  try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 2); assert.equal(check.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); } finally { check.close(); }
}));

test("binding a broad draft to a duplicate app skill rejects it without poisoning later evidence", async () => withStore(async store => {
  const captured = episode(1, "c".repeat(64));
  const automatic = await store.recordEpisode(captured); await store.beginJob(scope.modelProfile);
  const existing = { ...spec(), scope: captured.scope };
  await store.addCandidate(automatic.id, existing); await store.finishJob(automatic.id, "rejected");
  const duplicate = await store.createManagedSkill({ title: "同一恢复方法", spec: { ...existing, scope } });
  assert.equal(duplicate.state, "rejected"); assert.equal(duplicate.spec.scope.appDigest, captured.scope.appDigest);
  const next = await store.recordEpisode(episode(2, "d".repeat(64)));
  assert.equal(next.queued, true);
  assert.equal((await store.beginJob(scope.modelProfile))?.job.id, next.id);
  assert.equal((await store.listManagedSkills()).find(value => value.id === duplicate.id)?.state, "rejected");
}));

test("a duplicate introduced after manual queueing is rejected atomically and the next job is claimed", async () => withStore(async store => {
  const captured = episode(1, "c".repeat(64));
  const automatic = await store.recordEpisode(captured); await store.beginJob(scope.modelProfile);
  const original = spec();
  const manual = await store.createManagedSkill({ title: "正在等待评测", spec: original });
  assert.equal(manual.state, "draft");
  await store.addCandidate(automatic.id, { ...original, scope: captured.scope });
  await store.finishJob(automatic.id, "rejected");
  const next = await store.recordEpisode(episode(2, "d".repeat(64)));
  assert.equal(next.queued, true, "concurrent invalidation must not roll back new captured evidence");
  assert.equal((await store.beginJob(scope.modelProfile))?.job.id, next.id);
  assert.equal((await store.listManagedSkills()).find(value => value.id === manual.id)?.state, "rejected");
  const rejected = (await store.history()).jobs.filter(job => job.state === "rejected");
  assert.equal(rejected.length, 2);
}));

test("expired queued drafts are rejected, allow title-only edits and do not block the next job", async () => withStore(async store => {
  const now = Date.now(), expiring = { ...spec(), expiresAt: now + 60_000 };
  const manual = await store.createManagedSkill({ title: "即将过期", spec: expiring });
  await store.recordEpisode(episode(1, "c".repeat(64)));
  const next = await store.recordEpisode(episode(2, "d".repeat(64)));
  assert.equal((await store.beginJob(scope.modelProfile, now + 60_001))?.job.id, next.id);
  const rejected = (await store.listManagedSkills()).find(value => value.id === manual.id)!;
  assert.equal(rejected.state, "rejected");
  const realNow = Date.now;
  Date.now = () => now + 60_001;
  try {
    const renamed = await store.updateManagedSkill(manual.id, { title: "已过期的恢复方法", spec: rejected.spec });
    assert.equal(renamed.title, "已过期的恢复方法"); assert.equal(renamed.state, "rejected");
    assert.equal(renamed.spec.expiresAt, expiring.expiresAt);
    await assert.rejects(store.updateManagedSkill(manual.id, { title: "改内容仍需有效期限", spec: { ...rejected.spec, entryConditions: [{ fact: "hasObservation", test: "eq", value: true }] } }), /SKILLS_INVALID_MANAGED_SKILL/);
  } finally { Date.now = realNow; }
  assert.equal((await store.status()).queued, 0);
}));
