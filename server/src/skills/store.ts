import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { deepFreeze } from "../learning/schema.js";
import { SkillSpecSchema, SkillScopeSchema, SkillFeedbackSchema, SkillHashSchema, skillHash, semanticSkillHash, matchesScope, type SkillSpec, type SkillScope, type SkillFeedback } from "./schema.js";
import { FailureEpisodeSchema, episodeFingerprint, type FailureEpisode } from "./trace.js";
import { verifySkillReceipt, type SkillReceipt } from "./evaluation.js";
import { SkillFailureSchema, type SkillFailure } from "./failure.js";
import { SkillDatabase } from "./database.js";
import { JobSchema, RecordSchema, MAX_BYTES } from "./store-schema.js";
import { ManagedSkillInputSchema, type ManagedSkill, type ManagedSkillInput } from "./management.js";
export type { ManagedSkill, ManagedSkillInput } from "./management.js";

export type SkillJob = z.infer<typeof JobSchema>;
type SkillRecord = z.infer<typeof RecordSchema>;
type Row = Record<string, SQLOutputValue>;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const encoded = (value: unknown) => JSON.stringify(value);
const json = (value: SQLOutputValue | undefined): unknown => {
  if (typeof value !== "string") throw new Error("SKILLS_INVALID_STORE");
  try { return JSON.parse(value); } catch { throw new Error("SKILLS_INVALID_STORE"); }
};
function stored<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error("SKILLS_INVALID_STORE");
  return result.data;
}
const count = (row: Row | undefined): number => {
  if (!row || typeof row.count !== "number") throw new Error("SKILLS_INVALID_STORE");
  return row.count;
};
function jobFromRow(row: Row): SkillJob {
  return stored(JobSchema, {
    id: row.id, episodeId: row.episode_id, fingerprint: row.fingerprint, state: row.state,
    createdAt: row.created_at, ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.owner_pid === null ? {} : { ownerPid: row.owner_pid }),
    candidateHashes: json(row.candidate_hashes_json), feedback: json(row.feedback_json), modelCalls: row.model_calls,
    ...(row.last_failure_json === null ? {} : { lastFailure: json(row.last_failure_json) }),
  });
}
function recordFromRow(row: Row): SkillRecord {
  const record = stored(RecordSchema, { spec: json(row.spec_json), hash: row.hash, state: row.state,
    jobId: row.job_id, createdAt: row.created_at, successes: row.successes, failures: row.failures,
    ...(row.validation_json === null ? {} : { validation: json(row.validation_json) }),
  });
  // Indexed columns are a query accelerator, never a second source of truth
  // that can silently broaden the closed-schema program's scope.
  const spec = record.spec;
  if (row.semantic_hash !== semanticSkillHash(spec) || row.host_version !== spec.scope.hostVersion ||
      row.policy_revision !== spec.scope.policyRevision || row.model_profile !== spec.scope.modelProfile ||
      row.app_digest !== (spec.scope.appDigest ?? null) || row.expires_at !== spec.expiresAt ||
      row.scope_json !== encoded(spec.scope) || row.trigger_json !== encoded(spec.trigger)) throw new Error("SKILLS_INVALID_STORE");
  return record;
}
const getJob = (db: DatabaseSync, id: string) => {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  return row ? jobFromRow(row) : undefined;
};
const getRecord = (db: DatabaseSync, hash: string) => {
  const row = db.prepare("SELECT * FROM skills WHERE hash = ?").get(hash);
  return row ? recordFromRow(row) : undefined;
};
const enabled = (db: DatabaseSync) => db.prepare("SELECT enabled FROM metadata WHERE id = 1").get()?.enabled === 1;
const resetDay = (db: DatabaseSync, now: number) => {
  const current = day(now);
  db.prepare("UPDATE metadata SET daily_day = ?, daily_jobs = 0, daily_model_calls = 0 WHERE id = 1 AND daily_day <> ?").run(current, current);
};
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH"; }
}
function sameSlot(a: SkillSpec, b: SkillSpec) {
  return encoded(a.scope) === encoded(b.scope) && encoded(a.trigger) === encoded(b.trigger);
}
function trim(db: DatabaseSync) {
  // Keep insertion order and never evict queued/running jobs or active winners.
  const extraJobs = count(db.prepare("SELECT count(*) AS count FROM jobs").get()) - 64;
  if (extraJobs > 0) {
    const removed = db.prepare("DELETE FROM jobs WHERE seq IN (SELECT seq FROM jobs WHERE state NOT IN ('running', 'queued') ORDER BY seq LIMIT ?)").run(extraJobs);
    if (Number(removed.changes) !== extraJobs) throw new Error("SKILLS_STORE_LIMIT");
  }
  db.exec("DELETE FROM episodes WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.episode_id = episodes.id)");
  const extraSkills = count(db.prepare("SELECT count(*) AS count FROM skills").get()) - 128;
  if (extraSkills > 0) {
    const removed = db.prepare("DELETE FROM skills WHERE seq IN (SELECT seq FROM skills WHERE state IN ('rejected', 'revoked') AND NOT EXISTS (SELECT 1 FROM managed_skills WHERE managed_skills.skill_hash = skills.hash) ORDER BY seq LIMIT ?)").run(extraSkills);
    if (Number(removed.changes) !== extraSkills) throw new Error("SKILLS_STORE_LIMIT");
  }
}
/** Check the original logical JSON limit in SQLite only when payloads grow.
 * Routine model-call reservations never fetch or reserialize the ledger. */
function assertCapacity(db: DatabaseSync) {
  const bytes = count(db.prepare(`
    WITH episode_sizes AS (
      SELECT coalesce(sum(length(CAST(episode_json AS BLOB))), 0) + max(count(*) - 1, 0) AS bytes FROM episodes
    ), job_sizes AS (
      SELECT coalesce(sum(length(CAST(json_patch(
        json_object('id', id, 'episodeId', episode_id, 'fingerprint', fingerprint, 'state', state,
          'createdAt', created_at, 'candidateHashes', json(candidate_hashes_json),
          'feedback', json(feedback_json), 'modelCalls', model_calls),
        json_object('startedAt', started_at, 'finishedAt', finished_at, 'ownerPid', owner_pid,
          'lastFailure', json(last_failure_json))) AS BLOB))), 0) + max(count(*) - 1, 0) AS bytes FROM jobs
    ), skill_sizes AS (
      SELECT coalesce(sum(length(CAST(json_patch(
        json_object('spec', json(spec_json), 'hash', hash, 'state', state, 'jobId', job_id,
          'createdAt', created_at, 'successes', successes, 'failures', failures),
        json_object('validation', json(validation_json))) AS BLOB))), 0) + max(count(*) - 1, 0) AS bytes FROM skills
    )
    SELECT length(CAST(json_object('schemaVersion', schema_version,
      'enabled', json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END),
      'episodes', json('[]'), 'jobs', json('[]'), 'skills', json('[]'),
      'daily', json_object('day', daily_day, 'jobs', daily_jobs, 'modelCalls', daily_model_calls)) AS BLOB))
      + episode_sizes.bytes + job_sizes.bytes + skill_sizes.bytes AS count
    FROM metadata, episode_sizes, job_sizes, skill_sizes WHERE metadata.id = 1
  `).get());
  const managedBytes = count(db.prepare("SELECT coalesce(sum(length(CAST(spec_json AS BLOB)) + length(CAST(title AS BLOB)) + 256), 0) AS count FROM managed_skills").get());
  if (bytes + managedBytes > MAX_BYTES) throw new Error("SKILLS_STORE_LIMIT");
}
function revokeSkills(db: DatabaseSync, hashes: readonly string[], now: number) {
  const records = hashes.flatMap(hash => { const record = getRecord(db, hash); return record ? [record] : []; });
  // Withdraw the whole original set first: a withdrawn ancestor cannot be
  // reactivated just because its descendant happened to be processed first.
  const revoke = db.prepare("UPDATE skills SET failures = min(1000000, failures + 1), state = 'revoked' WHERE hash = ?");
  for (const record of records) revoke.run(record.hash);
  for (const record of records) {
    let ancestorHash = record.spec.lineage.parentHash;
    const visited = new Set<string>();
    while (ancestorHash && !visited.has(ancestorHash)) {
      visited.add(ancestorHash);
      const ancestor = getRecord(db, ancestorHash);
      if (!ancestor) break;
      if (ancestor.state === "superseded" && ancestor.failures === 0 && ancestor.validation && ancestor.spec.expiresAt > now && sameSlot(ancestor.spec, record.spec)) {
        const active = db.prepare("SELECT 1 FROM skills WHERE state = 'active' AND scope_json = ? AND trigger_json = ? LIMIT 1").get(encoded(ancestor.spec.scope), encoded(ancestor.spec.trigger));
        if (!active) db.prepare("UPDATE skills SET state = 'active' WHERE hash = ?").run(ancestor.hash);
        break;
      }
      ancestorHash = ancestor.spec.lineage.parentHash;
    }
  }
}
const scopePredicate = "host_version = ? AND policy_revision = ? AND model_profile = ? AND (app_digest IS NULL OR app_digest = ?)";
const snapshotOrder = "successes DESC, created_at DESC, seq ASC";
const scopeParameters = (scope: SkillScope) => [scope.hostVersion, scope.policyRevision, scope.modelProfile, scope.appDigest ?? null] as const;
function activeRecords(db: DatabaseSync, scope: SkillScope, now: number, limit = 3): SkillRecord[] {
  return db.prepare(`SELECT * FROM skills WHERE state = 'active' AND expires_at > ? AND ${scopePredicate} ORDER BY ${snapshotOrder} LIMIT ?`)
    .all(now, ...scopeParameters(scope), limit).map(recordFromRow);
}
function interruptDeadJobs(db: DatabaseSync, now: number, rejectCandidates: boolean) {
  const running = db.prepare("SELECT id, owner_pid FROM jobs WHERE state = 'running' ORDER BY seq").all();
  for (const row of running) {
    if (typeof row.id !== "string") throw new Error("SKILLS_INVALID_STORE");
    if (row.owner_pid === null || typeof row.owner_pid === "number" && !alive(row.owner_pid)) {
      db.prepare("UPDATE jobs SET state = 'interrupted', finished_at = ?, last_failure_json = ? WHERE id = ?")
        .run(now, encoded({ stage: "lifecycle", code: "SKILLS_INTERRUPTED" }), row.id);
      if (rejectCandidates) db.prepare("UPDATE skills SET state = 'rejected' WHERE job_id = ? AND state = 'candidate'").run(row.id);
    }
  }
}

function insertCandidate(db: DatabaseSync, jobId: string, spec: SkillSpec, now: number): string {
  const hash = skillHash(spec), semanticHash = semanticSkillHash(spec);
  const job = getJob(db, jobId), episodeRow = job && db.prepare("SELECT episode_json FROM episodes WHERE id = ?").get(job.episodeId);
  if (!job || job.state !== "running" || !episodeRow) throw new Error("SKILLS_JOB_CANCELLED");
  const episode = stored(FailureEpisodeSchema, json(episodeRow.episode_json));
  if (episode.id !== job.episodeId) throw new Error("SKILLS_INVALID_STORE");
  if (job.candidateHashes.length >= 2 || spec.expiresAt <= now || spec.expiresAt > now + 90 * 86_400_000 || encoded(spec.scope) !== encoded(episode.scope) || encoded(spec.trigger) !== encoded(episode.trigger)) throw new Error("SKILLS_INVALID_CANDIDATE");
  if (db.prepare("SELECT 1 FROM skills WHERE semantic_hash = ? LIMIT 1").get(semanticHash)) throw new Error("SKILLS_DUPLICATE_CANDIDATE");
  if (spec.lineage.parentHash && !db.prepare("SELECT 1 FROM skills WHERE hash = ?").get(spec.lineage.parentHash)) throw new Error("SKILLS_UNKNOWN_PARENT");
  stored(RecordSchema, { spec, hash, state: "candidate", jobId, createdAt: now, successes: 0, failures: 0 });
  db.prepare("UPDATE jobs SET candidate_hashes_json = ? WHERE id = ?").run(encoded([...job.candidateHashes, hash]), jobId);
  db.prepare(`INSERT INTO skills (hash, semantic_hash, state, job_id, created_at, successes, failures, host_version, policy_revision, model_profile, app_digest, expires_at, scope_json, trigger_json, spec_json)
    VALUES (?, ?, 'candidate', ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hash, semanticHash, jobId, now, spec.scope.hostVersion, spec.scope.policyRevision, spec.scope.modelProfile, spec.scope.appDigest ?? null, spec.expiresAt, encoded(spec.scope), encoded(spec.trigger), encoded(spec));
  trim(db);
  assertCapacity(db);
  return hash;
}

function managedFromRow(db: DatabaseSync, row: Row): ManagedSkill {
  const input = stored(ManagedSkillInputSchema, { title: row.title, spec: json(row.spec_json) });
  const source = stored(z.enum(["manual", "automatic"]), row.source);
  const record = typeof row.skill_hash === "string" ? getRecord(db, row.skill_hash) : undefined;
  if (row.skill_hash !== null && !record || record && encoded(record.spec) !== encoded(input.spec)) throw new Error("SKILLS_INVALID_STORE");
  const timestamp = z.number().int().nonnegative();
  return { id: stored(z.string().min(1).max(80), row.id), ...input, source,
    state: record?.state ?? stored(z.enum(["draft", "rejected"]), row.draft_state), createdAt: stored(timestamp, row.created_at), updatedAt: stored(timestamp, row.updated_at),
    successes: record?.successes ?? 0, failures: record?.failures ?? 0, ...(record?.validation ? { validation: record.validation } : {}) };
}
function automaticManaged(record: SkillRecord): ManagedSkill {
  return { id: record.hash, title: `${record.spec.trigger.errorCode} · ${record.spec.trigger.actionKind}`, source: "automatic",
    state: record.state, spec: record.spec, createdAt: record.createdAt, updatedAt: record.createdAt,
    successes: record.successes, failures: record.failures, ...(record.validation ? { validation: record.validation } : {}) };
}
function managedById(db: DatabaseSync, id: string): ManagedSkill | undefined {
  const row = db.prepare("SELECT * FROM managed_skills WHERE id = ?").get(id);
  if (row) return managedFromRow(db, row);
  const record = getRecord(db, id);
  if (record && !db.prepare("SELECT 1 FROM managed_skills WHERE skill_hash = ?").get(id)) return automaticManaged(record);
  return undefined;
}
function checkedManagedInput(input: ManagedSkillInput, now?: number): ManagedSkillInput {
  const parsed = ManagedSkillInputSchema.safeParse(input);
  if (!parsed.success || now !== undefined && (parsed.data.spec.expiresAt <= now || parsed.data.spec.expiresAt > now + 90 * 86_400_000)) throw new Error("SKILLS_INVALID_MANAGED_SKILL");
  return parsed.data;
}
function checkManagedDuplicate(db: DatabaseSync, spec: SkillSpec, exceptId?: string): void {
  const semantic = semanticSkillHash(spec);
  const duplicate = db.prepare("SELECT hash FROM skills WHERE semantic_hash = ?").get(semantic);
  const current = exceptId ? managedById(db, exceptId) : undefined;
  if (duplicate && duplicate.hash !== (current ? skillHash(current.spec) : undefined)) throw new Error("SKILLS_DUPLICATE_CANDIDATE");
  for (const row of db.prepare("SELECT id, spec_json FROM managed_skills WHERE skill_hash IS NULL").all()) {
    if (row.id !== exceptId && semanticSkillHash(stored(SkillSpecSchema, json(row.spec_json))) === semantic) throw new Error("SKILLS_DUPLICATE_CANDIDATE");
  }
  if (spec.lineage.parentHash && !getRecord(db, spec.lineage.parentHash)) throw new Error("SKILLS_UNKNOWN_PARENT");
}
/** A draft may only be tested against an actual, sanitized failure already in the
 * ledger. Its own identity deduplicates that evaluation; it is never active here. */
function enqueueManagedDrafts(db: DatabaseSync, now: number): void {
  if (!enabled(db)) return;
  const drafts = db.prepare("SELECT * FROM managed_skills WHERE source = 'manual' AND draft_state = 'draft' AND skill_hash IS NULL AND job_id IS NULL ORDER BY created_at").all();
  if (!drafts.length) return;
  const episodes = db.prepare("SELECT episode_json FROM episodes ORDER BY seq DESC").all().map(row => stored(FailureEpisodeSchema, json(row.episode_json)));
  for (const draft of drafts) {
    const spec = stored(SkillSpecSchema, json(draft.spec_json));
    if (spec.expiresAt <= now) continue;
    const episode = episodes.find(value => value.termination !== "cancelled" && value.steps.some(step => !["NONE", "UNKNOWN"].includes(step.errorCode)) && matchesScope(spec.scope, value.scope) && encoded(value.trigger) === encoded(spec.trigger));
    if (!episode) continue;
    // Bind a broad manual draft to one observed app before any evaluation.
    // Subsequent candidates and receipts retain the exact existing scope checks.
    const bound = SkillSpecSchema.parse({ ...spec, scope: episode.scope });
    if (db.prepare("SELECT 1 FROM skills WHERE semantic_hash = ?").get(semanticSkillHash(bound))) {
      db.prepare("UPDATE managed_skills SET spec_json = ?, draft_state = 'rejected', updated_at = ? WHERE id = ?").run(encoded(bound), now, draft.id!);
      continue;
    }
    const id = randomUUID(), fingerprint = createHash("sha256").update(encoded(["managed", draft.id, skillHash(bound), id])).digest("hex");
    db.prepare("INSERT INTO jobs (id, episode_id, fingerprint, state, created_at, candidate_hashes_json, feedback_json, model_calls) VALUES (?, ?, ?, 'queued', ?, '[]', '[]', 0)").run(id, episode.id, fingerprint, now);
    db.prepare("UPDATE managed_skills SET job_id = ?, spec_json = ? WHERE id = ?").run(id, encoded(bound), draft.id!);
    // The manually supplied candidate replaces redundant automatic generation
    // for this same queued evidence; other distinct failures remain queued.
    db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE episode_id = ? AND state = 'queued' AND id <> ? AND NOT EXISTS (SELECT 1 FROM managed_skills WHERE managed_skills.job_id = jobs.id)").run(now, episode.id, id);
  }
}
function withdrawManaged(db: DatabaseSync, current: ManagedSkill, now: number): void {
  const row = db.prepare("SELECT job_id, skill_hash FROM managed_skills WHERE id = ?").get(current.id);
  const hash = row?.skill_hash ?? (current.state !== "draft" ? skillHash(current.spec) : undefined);
  const jobId = row?.job_id ?? (typeof hash === "string" ? getRecord(db, hash)?.jobId : undefined);
  if (typeof jobId === "string") {
    db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ?, last_failure_json = ? WHERE id = ? AND state IN ('queued', 'running')")
      .run(now, encoded({ stage: "lifecycle", code: "SKILLS_CANCELLED" }), jobId);
    db.prepare("UPDATE skills SET state = 'rejected' WHERE job_id = ? AND state = 'candidate'").run(jobId);
  }
  // Remove the old executable identity so a concurrent receipt cannot adopt it,
  // and rollback cannot resurrect a skill explicitly deleted by the user.
  if (typeof hash === "string") db.prepare("DELETE FROM skills WHERE hash = ?").run(hash);
  db.prepare("DELETE FROM managed_skills WHERE id = ?").run(current.id);
}

export type StoreStatus = { enabled: boolean; activeSkills: number; queued: number; dailyJobs: number; dailyModelCalls: number; lastFailure?: SkillFailure };

/** Persistence accepts only closed-schema structural facts and procedural programs.
 * Evidence and programs cannot represent API keys, task prose, UI labels or model responses.
 * User-supplied management titles are separate display metadata, never prompts.
 * Tasks receive frozen in-memory snapshots; counters and lifecycle writes only
 * update their own SQLite rows inside one transaction. */
export class SkillStore {
  readonly directory: string;
  private readonly database: SkillDatabase;
  constructor(rootDirectory: string) { this.database = new SkillDatabase(rootDirectory); this.directory = this.database.directory; }
  async listManagedSkills(): Promise<readonly ManagedSkill[]> {
    return this.database.read(db => deepFreeze([
      ...db.prepare("SELECT * FROM managed_skills").all().map(row => managedFromRow(db, row)),
      ...db.prepare("SELECT skills.* FROM skills WHERE NOT EXISTS (SELECT 1 FROM managed_skills WHERE managed_skills.skill_hash = skills.hash)").all().map(recordFromRow).map(automaticManaged),
    ].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))));
  }
  async createManagedSkill(input: ManagedSkillInput): Promise<ManagedSkill> {
    const now = Date.now(), safe = checkedManagedInput(input, now);
    return this.database.write(db => {
      if (count(db.prepare("SELECT count(*) AS count FROM managed_skills").get()) >= 128) throw new Error("SKILLS_STORE_LIMIT");
      checkManagedDuplicate(db, safe.spec);
      const id = randomUUID();
      db.prepare("INSERT INTO managed_skills (id,title,source,spec_json,created_at,updated_at) VALUES (?,?,'manual',?,?,?)").run(id, safe.title, encoded(safe.spec), now, now);
      enqueueManagedDrafts(db, now); trim(db); assertCapacity(db);
      return deepFreeze(managedById(db, id)!);
    });
  }
  async updateManagedSkill(id: string, input: ManagedSkillInput): Promise<ManagedSkill> {
    const now = Date.now(), safe = checkedManagedInput(input);
    if (typeof id !== "string" || id.length > 80) throw new Error("SKILLS_NOT_FOUND");
    return this.database.write(db => {
      const current = managedById(db, id);
      if (!current) throw new Error("SKILLS_NOT_FOUND");
      if (encoded(safe.spec.scope) !== encoded(current.spec.scope)) throw new Error("SKILLS_INVALID_MANAGED_SKILL");
      if (skillHash(safe.spec) !== skillHash(current.spec) && safe.spec.lineage.parentHash === skillHash(current.spec)) throw new Error("SKILLS_UNKNOWN_PARENT");
      checkManagedDuplicate(db, safe.spec, id);
      if (skillHash(safe.spec) === skillHash(current.spec)) {
        // Renaming display metadata neither invalidates nor grants validation.
        const existing = db.prepare("SELECT 1 FROM managed_skills WHERE id = ?").get(id);
        if (existing) db.prepare("UPDATE managed_skills SET title = ?, updated_at = ? WHERE id = ?").run(safe.title, now, id);
        else db.prepare("INSERT INTO managed_skills (id,title,source,spec_json,skill_hash,job_id,created_at,updated_at) VALUES (?,?,'automatic',?,?,?,?,?)")
          .run(id, safe.title, encoded(safe.spec), id, getRecord(db, id)!.jobId, current.createdAt, now);
      } else {
        checkedManagedInput(safe, now);
        withdrawManaged(db, current, now);
        db.prepare("INSERT INTO managed_skills (id,title,source,spec_json,created_at,updated_at) VALUES (?,?,'manual',?,?,?)").run(id, safe.title, encoded(safe.spec), current.createdAt, now);
        enqueueManagedDrafts(db, now); trim(db);
      }
      assertCapacity(db);
      return deepFreeze(managedById(db, id)!);
    });
  }
  async deleteManagedSkill(id: string): Promise<void> {
    if (typeof id !== "string" || id.length > 80) throw new Error("SKILLS_NOT_FOUND");
    await this.database.write(db => {
      const current = managedById(db, id);
      if (!current) throw new Error("SKILLS_NOT_FOUND");
      withdrawManaged(db, current, Date.now());
    });
  }
  async status(now = Date.now()): Promise<StoreStatus> {
    return this.database.read(db => {
      const metadata = db.prepare("SELECT enabled, daily_day, daily_jobs, daily_model_calls FROM metadata WHERE id = 1").get();
      if (!metadata) throw new Error("SKILLS_INVALID_STORE");
      const latest = db.prepare("SELECT last_failure_json FROM jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, seq DESC LIMIT 1").get();
      return { enabled: metadata.enabled === 1,
        activeSkills: count(db.prepare("SELECT count(*) AS count FROM skills WHERE state = 'active' AND expires_at > ?").get(now)),
        queued: count(db.prepare("SELECT count(*) AS count FROM jobs WHERE state = 'queued'").get()),
        dailyJobs: metadata.daily_day === day(now) ? Number(metadata.daily_jobs) : 0,
        dailyModelCalls: metadata.daily_day === day(now) ? Number(metadata.daily_model_calls) : 0,
        ...(latest?.last_failure_json ? { lastFailure: stored(SkillFailureSchema, json(latest.last_failure_json)) } : {}),
      };
    });
  }
  async setEnabled(value: boolean): Promise<void> {
    if (typeof value !== "boolean") throw new Error("SKILLS_INVALID_STATE");
    await this.database.write(db => {
      db.prepare("UPDATE metadata SET enabled = ? WHERE id = 1").run(value ? 1 : 0);
      if (value) {
        // An explicitly resumed, never-dispatched draft may reuse its queue
        // reservation. Already evaluated/interrupted attempts are never replayed.
        db.exec("UPDATE jobs SET state = 'queued', finished_at = NULL, last_failure_json = NULL WHERE state = 'cancelled' AND started_at IS NULL AND EXISTS (SELECT 1 FROM managed_skills WHERE managed_skills.job_id = jobs.id AND managed_skills.skill_hash IS NULL)");
        enqueueManagedDrafts(db, Date.now());
      }
      if (!value) db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ?, last_failure_json = ? WHERE state = 'queued'")
        .run(Date.now(), encoded({ stage: "lifecycle", code: "SKILLS_CANCELLED" }));
    });
  }
  async loadSnapshot(scope: SkillScope, now = Date.now()): Promise<readonly SkillSpec[]> {
    const current = SkillScopeSchema.parse(scope);
    return this.database.read(db => enabled(db) ? deepFreeze(activeRecords(db, current, now).map(record => record.spec)) : Object.freeze([]));
  }
  async loadTaskSnapshot(scope: SkillScope, now = Date.now()): Promise<readonly SkillSpec[]> {
    const current = SkillScopeSchema.parse(scope);
    return this.database.read(db => {
      if (!enabled(db)) return Object.freeze([]);
      return deepFreeze(db.prepare(`SELECT * FROM skills WHERE state = 'active' AND expires_at > ? AND host_version = ? AND policy_revision = ? AND model_profile = ? ORDER BY ${snapshotOrder} LIMIT 64`)
        .all(now, current.hostVersion, current.policyRevision, current.modelProfile).map(recordFromRow).map(record => record.spec));
    });
  }
  async recordEpisode(input: unknown, now = Date.now()): Promise<{ id: string; queued: boolean }> {
    const parsed = FailureEpisodeSchema.safeParse(input);
    if (!parsed.success) throw new Error("SKILLS_INVALID_EPISODE");
    const episode = parsed.data, fingerprint = createHash("sha256").update(encoded([episodeFingerprint(episode), episode.appliedSkillHashes])).digest("hex");
    return this.database.write(db => {
      const previous = db.prepare("SELECT id FROM jobs WHERE fingerprint = ? ORDER BY seq LIMIT 1").get(fingerprint);
      if (previous) {
        if (typeof previous.id !== "string") throw new Error("SKILLS_INVALID_STORE");
        return { id: previous.id, queued: false };
      }
      const queued = enabled(db) && episode.termination !== "cancelled" && episode.steps.some(step => !["NONE", "UNKNOWN"].includes(step.errorCode));
      const job = stored(JobSchema, { id: randomUUID(), episodeId: episode.id, fingerprint, state: queued ? "queued" : "cancelled", createdAt: now, candidateHashes: [], feedback: [], modelCalls: 0 });
      if (db.prepare("SELECT 1 FROM episodes WHERE id = ?").get(episode.id)) throw new Error("SKILLS_DUPLICATE_EPISODE");
      db.prepare("INSERT INTO episodes (id, model_profile, episode_json) VALUES (?, ?, ?)").run(episode.id, episode.scope.modelProfile, encoded(episode));
      db.prepare("INSERT INTO jobs (id, episode_id, fingerprint, state, created_at, candidate_hashes_json, feedback_json, model_calls) VALUES (?, ?, ?, ?, ?, '[]', '[]', 0)")
        .run(job.id, job.episodeId, job.fingerprint, job.state, job.createdAt);
      enqueueManagedDrafts(db, now);
      trim(db);
      assertCapacity(db);
      return { id: job.id, queued };
    });
  }
  async recoverInterrupted(now = Date.now()): Promise<void> {
    await this.database.write(db => interruptDeadJobs(db, now, true));
  }
  async beginJob(modelProfile: string, now = Date.now()): Promise<{ job: SkillJob; episode: FailureEpisode; parent?: SkillSpec; candidate?: { hash: string; spec: SkillSpec } } | undefined> {
    SkillHashSchema.parse(modelProfile);
    return this.database.write(db => {
      resetDay(db, now);
      // Crashed reservations remain consumed; partially evaluated work never replays.
      interruptDeadJobs(db, now, false);
      const metadata = db.prepare("SELECT enabled, daily_jobs, daily_model_calls FROM metadata WHERE id = 1").get();
      if (!metadata || metadata.enabled !== 1 || db.prepare("SELECT 1 FROM jobs WHERE state = 'running' LIMIT 1").get()) return undefined;
      db.prepare("UPDATE managed_skills SET draft_state = 'rejected' WHERE skill_hash IS NULL AND json_extract(spec_json, '$.expiresAt') <= ?").run(now);
      db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE state = 'queued' AND EXISTS (SELECT 1 FROM managed_skills WHERE managed_skills.job_id = jobs.id AND managed_skills.draft_state = 'rejected')").run(now);
      for (;;) {
      const row = db.prepare("SELECT jobs.* FROM jobs JOIN episodes ON episodes.id = jobs.episode_id WHERE jobs.state = 'queued' AND episodes.model_profile = ? ORDER BY EXISTS(SELECT 1 FROM managed_skills WHERE managed_skills.job_id = jobs.id) DESC, jobs.seq LIMIT 1").get(modelProfile);
      if (!row) return undefined;
      const job = jobFromRow(row);
      const episode = stored(FailureEpisodeSchema, json(db.prepare("SELECT episode_json FROM episodes WHERE id = ?").get(job.episodeId)?.episode_json));
      if (episode.id !== job.episodeId || episode.scope.modelProfile !== modelProfile) throw new Error("SKILLS_INVALID_STORE");
      const started = stored(JobSchema, { ...job, state: "running", startedAt: now, ownerPid: process.pid });
      db.prepare("UPDATE jobs SET state = 'running', started_at = ?, owner_pid = ? WHERE id = ?").run(now, process.pid, job.id);
      db.prepare("UPDATE metadata SET daily_jobs = daily_jobs + 1 WHERE id = 1").run();
      let parent: SkillSpec | undefined;
      for (const hash of episode.appliedSkillHashes) {
        const used = db.prepare("SELECT * FROM skills WHERE hash = ? AND scope_json = ? AND trigger_json = ?").get(hash, encoded(episode.scope), encoded(episode.trigger));
        if (used) { parent = recordFromRow(used).spec; break; }
      }
      if (!parent) {
        const active = db.prepare(`SELECT * FROM skills WHERE state = 'active' AND expires_at > ? AND ${scopePredicate} AND trigger_json = ? ORDER BY created_at DESC, seq ASC LIMIT 1`)
          .get(now, ...scopeParameters(episode.scope), encoded(episode.trigger));
        if (active) parent = recordFromRow(active).spec;
      }
      const managed = db.prepare("SELECT * FROM managed_skills WHERE job_id = ? AND skill_hash IS NULL").get(job.id);
      let candidate: { hash: string; spec: SkillSpec } | undefined;
      if (managed) {
        const spec = stored(SkillSpecSchema, json(managed.spec_json));
        let hash: string;
        try { hash = insertCandidate(db, job.id, spec, now); }
        catch (error) {
          if (!(error instanceof Error) || !["SKILLS_DUPLICATE_CANDIDATE", "SKILLS_INVALID_CANDIDATE", "SKILLS_UNKNOWN_PARENT"].includes(error.message)) throw error;
          db.prepare("UPDATE jobs SET state = 'rejected', finished_at = ?, last_failure_json = ? WHERE id = ?").run(now, encoded({ stage: "lifecycle", code: "SKILLS_JOB_FAILED" }), job.id);
          db.prepare("UPDATE managed_skills SET draft_state = 'rejected', updated_at = ? WHERE id = ?").run(now, managed.id!);
          continue;
        }
        db.prepare("UPDATE managed_skills SET skill_hash = ?, updated_at = ? WHERE id = ?").run(hash, now, managed.id!);
        candidate = { hash, spec };
      }
      return deepFreeze({ job: getJob(db, job.id) ?? started, episode, ...(parent ? { parent } : {}), ...(candidate ? { candidate } : {}) });
      }
    });
  }
  async reserveModelCall(jobId: string, now = Date.now(), budget: 100 | 150 = 100): Promise<void> {
    if (budget !== 100 && budget !== 150) throw new Error("SKILLS_INVALID_BUDGET");
    await this.database.write(db => {
      resetDay(db, now);
      const job = db.prepare("SELECT state, model_calls FROM jobs WHERE id = ?").get(jobId);
      const metadata = db.prepare("SELECT enabled, daily_model_calls FROM metadata WHERE id = 1").get();
      if (!job || job.state !== "running" || metadata?.enabled !== 1) throw new Error("SKILLS_JOB_CANCELLED");
      if (Number(job.model_calls) >= budget) throw new Error("SKILLS_BUDGET_EXHAUSTED");
      db.prepare("UPDATE jobs SET model_calls = model_calls + 1 WHERE id = ?").run(jobId);
      db.prepare("UPDATE metadata SET daily_model_calls = daily_model_calls + 1 WHERE id = 1").run();
    });
  }
  async addCandidate(jobId: string, input: unknown, now = Date.now()): Promise<string> {
    const spec = SkillSpecSchema.parse(input);
    return this.database.write(db => insertCandidate(db, jobId, spec, now));
  }

  async rejectCandidate(jobId: string, input: SkillFeedback): Promise<void> {
    const feedback = SkillFeedbackSchema.parse(input);
    await this.database.write(db => {
      const job = getJob(db, jobId), record = getRecord(db, feedback.skillHash);
      if (!job || job.state !== "running" || !record || record.jobId !== jobId || record.state !== "candidate") throw new Error("SKILLS_NOT_CANDIDATE");
      const updated = stored(JobSchema, { ...job, feedback: [...job.feedback, feedback] });
      db.prepare("UPDATE skills SET state = 'rejected' WHERE hash = ?").run(record.hash);
      db.prepare("UPDATE jobs SET feedback_json = ? WHERE id = ?").run(encoded(updated.feedback), jobId);
      assertCapacity(db);
    });
  }
  async adopt(jobId: string, hash: string, receipt: SkillReceipt, now = Date.now()): Promise<void> {
    await this.database.write(db => {
      const job = getJob(db, jobId), record = getRecord(db, hash), episodeRow = job && db.prepare("SELECT episode_json FROM episodes WHERE id = ?").get(job.episodeId);
      if (!enabled(db) || !job || job.state !== "running" || !record || record.jobId !== jobId || record.state !== "candidate" || !episodeRow || record.spec.expiresAt <= now) throw new Error("SKILLS_NOT_CANDIDATE");
      const episode = stored(FailureEpisodeSchema, json(episodeRow.episode_json));
      if (episode.id !== job.episodeId) throw new Error("SKILLS_INVALID_STORE");
      const validation = verifySkillReceipt(record.spec, episode, receipt);
      const incumbents = activeRecords(db, episode.scope, now).map(current => current.hash).sort();
      if (encoded(incumbents) !== encoded([...validation.incumbentHashes].sort())) throw new Error("SKILLS_INCUMBENT_CHANGED");
      db.prepare("UPDATE skills SET state = 'superseded' WHERE state = 'active' AND scope_json = ? AND trigger_json = ?").run(encoded(record.spec.scope), encoded(record.spec.trigger));
      db.prepare("UPDATE skills SET state = 'active', validation_json = ? WHERE hash = ?").run(encoded(validation), hash);
      db.prepare("UPDATE jobs SET state = 'adopted', finished_at = ?, last_failure_json = NULL WHERE id = ?").run(now, jobId);
      assertCapacity(db);
    });
  }
  async finishJob(jobId: string, result: "interrupted" | "rejected" | "cancelled" | "exhausted", now = Date.now(), failure?: SkillFailure): Promise<void> {
    const safeFailure = failure === undefined ? undefined : SkillFailureSchema.parse(failure);
    await this.database.write(db => {
      if (db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId)?.state !== "running") return;
      const lastFailure = safeFailure ?? { stage: "lifecycle", code: result === "interrupted" ? "SKILLS_INTERRUPTED" : result === "cancelled" ? "SKILLS_CANCELLED" : result === "exhausted" ? "SKILLS_BUDGET_EXHAUSTED" : "SKILLS_JOB_FAILED" };
      db.prepare("UPDATE jobs SET state = ?, finished_at = ?, last_failure_json = ? WHERE id = ?").run(result, now, encoded(lastFailure), jobId);
      db.prepare("UPDATE skills SET state = 'rejected' WHERE job_id = ? AND state = 'candidate'").run(jobId);
    });
  }
  async cancelQueued(now = Date.now()): Promise<void> {
    await this.database.write(db => db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ?, last_failure_json = ? WHERE state = 'queued'")
      .run(now, encoded({ stage: "lifecycle", code: "SKILLS_CANCELLED" })));
  }
  async recordUsageOutcome(hashes: readonly string[], outcome: "success" | "failure", now = Date.now()): Promise<void> {
    const checked = z.array(SkillHashSchema).max(3).parse(hashes);
    if (!["success", "failure"].includes(outcome)) throw new Error("SKILLS_INVALID_OUTCOME");
    await this.database.write(db => {
      if (outcome === "failure") { revokeSkills(db, checked, now); return; }
      const update = db.prepare("UPDATE skills SET successes = min(1000000, successes + 1) WHERE hash = ?");
      for (const hash of checked) update.run(hash);
    });
  }
  async rollback(now = Date.now()): Promise<void> {
    await this.database.write(db => revokeSkills(db, db.prepare("SELECT hash FROM skills WHERE state = 'active' ORDER BY seq").all().map(row => SkillHashSchema.parse(row.hash)), now));
  }
  /** Read-only, validated report evidence; exported metadata is not an adoption receipt. */
  async exportCandidates(): Promise<readonly Pick<SkillRecord, "hash" | "state" | "spec" | "validation">[]> {
    return this.database.read(db => {
      const rows = db.prepare("SELECT * FROM skills ORDER BY seq LIMIT 129").all();
      if (rows.length > 128) throw new Error("SKILLS_INVALID_STORE");
      return deepFreeze(rows.map(row => {
        const { hash, state, spec, validation } = recordFromRow(row);
        return { hash, state, spec, ...(validation ? { validation } : {}) };
      }));
    });
  }
  async history(): Promise<{ jobs: readonly SkillJob[]; skills: readonly { hash: string; state: string }[] }> {
    return this.database.read(db => deepFreeze({ jobs: db.prepare("SELECT * FROM jobs ORDER BY seq").all().map(jobFromRow),
      skills: db.prepare("SELECT hash, state FROM skills ORDER BY seq").all().map(row => ({ hash: SkillHashSchema.parse(row.hash), state: z.enum(["candidate", "active", "superseded", "revoked", "rejected"]).parse(row.state) })),
    }));
  }
}
