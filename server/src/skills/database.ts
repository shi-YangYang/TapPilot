import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { StateSchema, initialState, MAX_BYTES, type StoreState } from "./store-schema.js";
import { semanticSkillHash } from "./schema.js";
import { acquireLegacyLock } from "./legacy-lock.js";

const LEGACY_OWNER = "TapPilot procedural skills schema 1\n";
const OWNER = "TapPilot procedural skills SQLite schema 1\n";
const channels = new Map<string, Promise<unknown>>();
const hasCode = (error: unknown, code: string) => !!error && typeof error === "object" && "code" in error && error.code === code;
const invalid = (): never => { throw new Error("SKILLS_INVALID_STORE"); };
const safeError = (error: unknown) => new Error(error instanceof Error && /^SKILLS_[A-Z_]+$/.test(error.message)
  ? error.message : error && typeof error === "object" && "errcode" in error && [11, 19, 26].includes(Number(error.errcode) & 255)
    ? "SKILLS_INVALID_STORE" : "SKILLS_STORAGE_UNAVAILABLE");
const schema = `
CREATE TABLE metadata (
  id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), daily_day TEXT NOT NULL,
  daily_jobs INTEGER NOT NULL CHECK(daily_jobs BETWEEN 0 AND 2),
  daily_model_calls INTEGER NOT NULL CHECK(daily_model_calls BETWEEN 0 AND 200), legacy_sha256 TEXT
) STRICT;
CREATE TABLE episodes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, model_profile TEXT NOT NULL, episode_json TEXT NOT NULL
) STRICT;
CREATE TABLE jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, episode_id TEXT NOT NULL REFERENCES episodes(id),
  fingerprint TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('queued','running','interrupted','adopted','rejected','cancelled','exhausted')),
  created_at INTEGER NOT NULL CHECK(created_at>=0), started_at INTEGER, finished_at INTEGER, owner_pid INTEGER,
  candidate_hashes_json TEXT NOT NULL, feedback_json TEXT NOT NULL, model_calls INTEGER NOT NULL CHECK(model_calls BETWEEN 0 AND 1000000), last_failure_json TEXT
) STRICT;
CREATE TABLE skills (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, semantic_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('candidate','active','superseded','revoked','rejected')),
  job_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0),
  successes INTEGER NOT NULL CHECK(successes BETWEEN 0 AND 1000000), failures INTEGER NOT NULL CHECK(failures BETWEEN 0 AND 1000000),
  host_version TEXT NOT NULL, policy_revision TEXT NOT NULL, model_profile TEXT NOT NULL, app_digest TEXT,
  expires_at INTEGER NOT NULL CHECK(expires_at>=0), scope_json TEXT NOT NULL, trigger_json TEXT NOT NULL,
  spec_json TEXT NOT NULL, validation_json TEXT,
  CHECK(state NOT IN ('active','superseded') OR validation_json IS NOT NULL)
) STRICT;
CREATE INDEX episodes_model ON episodes(model_profile,id);
CREATE INDEX jobs_queue ON jobs(state,seq);
CREATE INDEX jobs_episode ON jobs(episode_id);
CREATE INDEX jobs_finished ON jobs(finished_at DESC,seq DESC);
CREATE INDEX skills_scope ON skills(state,host_version,policy_revision,model_profile,app_digest,expires_at);
CREATE INDEX skills_slot ON skills(state,scope_json,trigger_json);
CREATE INDEX skills_job ON skills(job_id,state);
PRAGMA user_version=1;
`;

/** SQLite WAL reset fixes: older supported Node runtimes use rollback journals.
 * No package/native-addon ABI is involved; both Node and Electron use node:sqlite. */
function safeWal(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major > 3 || major === 3 && (minor > 51 || minor === 51 && patch >= 3 || minor === 50 && patch >= 7 || minor === 44 && patch >= 6);
}
async function checkedFile(path: string, max = 32 * 1024 * 1024, optional = false): Promise<boolean> {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (optional && hasCode(error, "ENOENT")) return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max
    || process.getuid && stat.uid !== process.getuid()) throw new Error("SKILLS_UNSAFE_STORAGE");
  await chmod(path, 0o600);
  return true;
}
async function privateText(path: string, max: number): Promise<string> {
  await checkedFile(path, max);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error("SKILLS_UNSAFE_STORAGE");
    const bytes = await handle.readFile();
    if (bytes.length > max) throw new Error("SKILLS_STORE_LIMIT");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalid(); }
  } finally { await handle.close(); }
}
async function publishOwner(directory: string, replace = false): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.owner.tmp`), destination = join(directory, ".owner");
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(replace ? OWNER : LEGACY_OWNER); await handle.sync(); } finally { await handle.close(); }
  try {
    if (replace) {
      // The legacy write lock is held during sealing. A future old-version open
      // rejects this owner marker instead of silently writing its stale JSON.
      await rename(temporary, destination);
    } else { await rename(temporary, destination); }
  } finally { await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; }); }
}
function importState(db: DatabaseSync, state: StoreState, sourceHash: string | null): void {
  db.prepare("INSERT INTO metadata VALUES(1,1,?,?,?,?,?)").run(Number(state.enabled), state.daily.day, state.daily.jobs, state.daily.modelCalls, sourceHash);
  const episode = db.prepare("INSERT INTO episodes(id,model_profile,episode_json) VALUES(?,?,?)");
  for (const value of state.episodes) episode.run(value.id, value.scope.modelProfile, JSON.stringify(value));
  const job = db.prepare("INSERT INTO jobs(id,episode_id,fingerprint,state,created_at,started_at,finished_at,owner_pid,candidate_hashes_json,feedback_json,model_calls,last_failure_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const value of state.jobs) job.run(value.id, value.episodeId, value.fingerprint, value.state, value.createdAt,
    value.startedAt ?? null, value.finishedAt ?? null, value.ownerPid ?? null, JSON.stringify(value.candidateHashes),
    JSON.stringify(value.feedback), value.modelCalls, value.lastFailure ? JSON.stringify(value.lastFailure) : null);
  const skill = db.prepare("INSERT INTO skills(hash,semantic_hash,state,job_id,created_at,successes,failures,host_version,policy_revision,model_profile,app_digest,expires_at,scope_json,trigger_json,spec_json,validation_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const value of state.skills) {
    const spec = value.spec;
    skill.run(value.hash, semanticSkillHash(spec), value.state, value.jobId, value.createdAt, value.successes, value.failures,
      spec.scope.hostVersion, spec.scope.policyRevision, spec.scope.modelProfile, spec.scope.appDigest ?? null, spec.expiresAt,
      JSON.stringify(spec.scope), JSON.stringify(spec.trigger), JSON.stringify(spec), value.validation ? JSON.stringify(value.validation) : null);
  }
}

export class SkillDatabase {
  readonly directory: string;
  private readonly path: string;
  constructor(readonly rootDirectory: string) {
    this.directory = join(resolve(rootDirectory), "skills-v1"); this.path = join(this.directory, "skills.sqlite3");
  }
  private async prepare(): Promise<string> {
    const root = await lstat(resolve(this.rootDirectory));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("SKILLS_UNSAFE_STORAGE");
    try { await mkdir(this.directory, { mode: 0o700 }); await publishOwner(this.directory); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || process.getuid && directory.uid !== process.getuid()) throw new Error("SKILLS_UNSAFE_STORAGE");
    await chmod(this.directory, 0o700);
    let owner = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      try { owner = await privateText(join(this.directory, ".owner"), 128); break; }
      catch (error) { if (!hasCode(error, "ENOENT") || attempt === 49) throw error; await delay(10); }
    }
    if (![OWNER, LEGACY_OWNER].includes(owner)) throw new Error("SKILLS_UNSAFE_STORAGE");
    await this.checkPaths();
    if (!await checkedFile(this.path, undefined, true)) {
      // A migrated owner with a legacy backup must never resurrect stale data
      // after the SQLite database is lost.
      if (owner === OWNER) invalid();
      try {
        const handle = await open(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.close();
      } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    }
    if (owner === OWNER && (await lstat(this.path)).size === 0) invalid();
    return owner;
  }
  private async checkPaths(): Promise<void> {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      // Other short-lived connections may checkpoint/delete a sidecar here.
      try { await checkedFile(this.path + suffix, undefined, true); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }
  }
  private async retryBusy<T>(work: () => T | Promise<T>, legacyLock = false): Promise<T> {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { return await work(); }
      catch (error) {
        const code = error && typeof error === "object" && "errcode" in error ? Number(error.errcode) & 255 : 0;
        if (![5, 6].includes(code) && !(legacyLock && error instanceof Error && error.message === "SKILLS_LOCK_BUSY")) throw error;
        if (Date.now() >= deadline) throw new Error("SKILLS_LOCK_BUSY");
        await delay(20);
      }
    }
  }
  private begin(db: DatabaseSync, sql: string): Promise<void> { return this.retryBusy(() => db.exec(sql)); }
  private async seal(db: DatabaseSync): Promise<void> {
    if (await privateText(join(this.directory, ".owner"), 128) === OWNER) return;
    const release = await this.retryBusy(() => acquireLegacyLock(this.directory), true);
    try {
      const owner = await privateText(join(this.directory, ".owner"), 128);
      if (owner === OWNER) return;
      if (owner !== LEGACY_OWNER) throw new Error("SKILLS_UNSAFE_STORAGE");
      const expected = db.prepare("SELECT legacy_sha256 FROM metadata WHERE id=1").get()?.legacy_sha256;
      const path = join(this.directory, "state.json");
      const actual = await checkedFile(path, MAX_BYTES, true)
        ? createHash("sha256").update(await privateText(path, MAX_BYTES)).digest("hex") : null;
      // After a crash between DB commit and sealing, an old executable might
      // have written the JSON again. Never silently discard those later writes.
      if (expected !== actual) throw new Error("SKILLS_MIGRATION_CONFLICT");
      await publishOwner(this.directory, true);
    } finally { await release(); }
  }
  private async initialize(db: DatabaseSync, owner: string): Promise<void> {
    const version = () => db.prepare("PRAGMA user_version").get()?.user_version;
    if (version() === 1) {
      if (db.prepare("SELECT schema_version FROM metadata WHERE id=1").get()?.schema_version !== 1) invalid();
      if (owner === LEGACY_OWNER) await this.seal(db);
      return;
    }
    if (version() !== 0 || owner === OWNER) invalid();
    await this.begin(db, "BEGIN IMMEDIATE");
    let release: (() => Promise<void>) | undefined;
    try {
      if (version() === 1) { await this.begin(db, "COMMIT"); await this.seal(db); return; }
      if (version() !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) invalid();
      release = await this.retryBusy(() => acquireLegacyLock(this.directory), true);
      const legacyPath = join(this.directory, "state.json");
      let state = initialState(), hash: string | null = null;
      if (await checkedFile(legacyPath, MAX_BYTES, true)) {
        if (owner !== LEGACY_OWNER) invalid();
        const text = await privateText(legacyPath, MAX_BYTES);
        try { state = StateSchema.parse(JSON.parse(text)); } catch { invalid(); }
        hash = createHash("sha256").update(text).digest("hex");
      }
      db.exec(schema); importState(db, state, hash); await this.begin(db, "COMMIT");
      if (owner === LEGACY_OWNER) await publishOwner(this.directory, true);
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already committed */ } throw error; }
    finally { await release?.(); }
  }
  private async connection<T>(write: boolean, work: (db: DatabaseSync) => T): Promise<T> {
    let db: DatabaseSync | undefined;
    try {
      const owner = await this.prepare();
      db = await this.retryBusy(() => new DatabaseSync(this.path));
      const connected = db;
      // Connection setup can also encounter another process's short exclusive
      // lock. Retry only setup/read work; never replay a modifying callback.
      await this.retryBusy(async () => {
        connected.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
        const version = connected.prepare("SELECT sqlite_version() AS version").get()?.version;
        const mode = typeof version === "string" && safeWal(version) ? "wal" : "delete";
        if (connected.prepare("PRAGMA journal_mode").get()?.journal_mode !== mode) await this.begin(connected, `PRAGMA journal_mode=${mode}`);
        await this.checkPaths();
        await this.initialize(connected, owner);
      });
      const transaction = async () => {
        await this.begin(connected, write ? "BEGIN IMMEDIATE" : "BEGIN");
        try { const result = work(connected); await this.begin(connected, "COMMIT"); return result; }
        catch (error) { try { connected.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
      };
      return await (write ? transaction() : this.retryBusy(transaction));
    } catch (error) { throw safeError(error); }
    finally { db?.close(); }
  }
  private serial<T>(write: boolean, work: (db: DatabaseSync) => T): Promise<T> {
    const previous = channels.get(this.directory) ?? Promise.resolve();
    const current = previous.then(() => this.connection(write, work), () => this.connection(write, work));
    const tail = current.catch(() => {}); channels.set(this.directory, tail);
    void tail.finally(() => { if (channels.get(this.directory) === tail) channels.delete(this.directory); });
    return current;
  }
  read<T>(work: (db: DatabaseSync) => T): Promise<T> { return this.serial(false, work); }
  write<T>(work: (db: DatabaseSync) => T): Promise<T> { return this.serial(true, work); }
}
