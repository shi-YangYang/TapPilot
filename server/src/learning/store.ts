import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { candidateHash, semanticFingerprint, CandidateSpecSchema, deepFreeze, ExperienceSchema, type Experience, type FrozenSnapshot, type ModelFamilySchema } from "./schema.js";
import { validateEvidence } from "./validation.js";
const MAX_RECORDS = 64, MAX_BYTES = 1024 * 1024;
const recordsSchema = z.array(ExperienceSchema).max(MAX_RECORDS);
const OWNER = "TapPilot learning schema 1\n";
const channels = new Map<string, Promise<unknown>>();
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
const exists = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
const fixed = (error: unknown) => new Error(error instanceof Error && /^LEARNING_[A-Z_]+$/.test(error.message) ? error.message : "LEARNING_STORAGE_UNAVAILABLE");
const lockSchema = z.object({ pid: z.number().int().min(1).max(2_147_483_647), token: z.string().uuid() }).strict();
type LockOwner = z.infer<typeof lockSchema>;
type LockRecord = { owner: LockOwner; stat: Stats };
const recoveryPrefix = ".write-recovery-";
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH"; }
}
const sameFile = (first: Stats, second: Stats) => first.ino === second.ino && first.dev === second.dev;
export class LearningStore {
  readonly directory: string;
  constructor(readonly rootDirectory: string) { this.directory = join(resolve(rootDirectory), "learning-v1"); }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = channels.get(this.directory) ?? Promise.resolve();
    const current = previous.then(work, work);
    channels.set(this.directory, current.catch(() => {}));
    try { return await current; } catch (error) { throw fixed(error); }
  }
  private async file(path: string, max = MAX_BYTES) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw new Error("LEARNING_UNSAFE_STORAGE");
  }
  private async prepare(create: boolean) {
    const root = await lstat(resolve(this.rootDirectory));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("LEARNING_UNSAFE_STORAGE");
    let created = false;
    if (create) try { await mkdir(this.directory, { mode: 0o700 }); created = true; }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("LEARNING_UNSAFE_STORAGE");
    const path = join(this.directory, ".owner");
    if (created) { const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(OWNER); } finally { await handle.close(); } }
    await this.file(path, 128);
    const owner = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (await owner.readFile("utf8") !== OWNER) throw new Error("LEARNING_UNSAFE_STORAGE"); } finally { await owner.close(); }
    await chmod(this.directory, 0o700); await chmod(path, 0o600);
  }
  private async read(): Promise<Experience[]> {
    const path = join(this.directory, "experiences.json");
    try { await this.file(path); } catch (error) { if (missing(error)) return []; throw error; }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("LEARNING_UNSAFE_STORAGE");
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("LEARNING_STORE_LIMIT");
      const records = recordsSchema.safeParse(JSON.parse(text));
      if (!records.success || new Set(records.data.map(r => r.id)).size !== records.data.length) throw new Error("LEARNING_INVALID_STORE");
      return records.data;
    } finally { await handle.close(); }
  }
  private async write(records: Experience[]) {
    const validated = recordsSchema.safeParse(records);
    if (!validated.success) throw new Error("LEARNING_INVALID_STORE");
    const content = JSON.stringify(validated.data);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("LEARNING_STORE_LIMIT");
    const destination = join(this.directory, "experiences.json");
    try { await this.file(destination); } catch (error) { if (!missing(error)) throw error; }
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    finally { await handle.close(); }
    try { await rename(temporary, destination); } finally { await unlink(temporary).catch(() => {}); }
  }
  private async readLock(path: string): Promise<LockRecord> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 512 || process.getuid && before.uid !== process.getuid()) throw new Error("LEARNING_UNSAFE_LOCK");
    // A crash between publication and temporary-file cleanup can leave the
    // second link. Metadata stays complete and recoverable; it is never written.
    if (before.nlink < 1 || before.nlink > 2) throw new Error("LEARNING_UNSAFE_LOCK");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!sameFile(before, stat) || !stat.isFile() || stat.nlink < 1 || stat.nlink > 2 || stat.size > 512) throw new Error("LEARNING_UNSAFE_LOCK");
      const parsed = lockSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
      if (!parsed.success) throw new Error("LEARNING_UNSAFE_LOCK");
      return { owner: parsed.data, stat };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("LEARNING_UNSAFE_LOCK");
      throw error;
    } finally { await handle.close(); }
  }
  private async publishLock(path: string, owner: LockOwner): Promise<LockRecord> {
    const temporary = join(this.directory, `.lock-publish-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner)); await handle.sync();
      // Unlike an empty O_EXCL lock file, the published owner is complete even
      // if the process exits immediately after acquiring the lock.
      await link(temporary, path);
    } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
    return this.readLock(path);
  }
  private async releaseLock(path: string, expected: LockRecord): Promise<void> {
    const current = await this.readLock(path);
    if (!sameFile(current.stat, expected.stat) || current.owner.pid !== expected.owner.pid || current.owner.token !== expected.owner.token) throw new Error("LEARNING_LOCK_OWNERSHIP_CHANGED");
    await unlink(path);
  }
  private async clearDeadRecoveryClaims(ownPath?: string): Promise<void> {
    for (const name of await readdir(this.directory)) {
      if (!name.startsWith(recoveryPrefix)) continue;
      const path = join(this.directory, name);
      if (path === ownPath) continue;
      const match = /^\.write-recovery-([1-9]\d*)-([a-f\d-]{36})$/.exec(name);
      if (!match) throw new Error("LEARNING_UNSAFE_LOCK");
      let record: LockRecord;
      try { record = await this.readLock(path); } catch (error) { if (missing(error)) continue; throw error; }
      if (record.owner.pid !== Number(match[1]) || record.owner.token !== match[2]) throw new Error("LEARNING_UNSAFE_LOCK");
      if (alive(record.owner.pid)) throw new Error("LEARNING_LOCK_BUSY");
      // Every recovery claim has a unique owner-token filename. Unlike the
      // shared lock path, it can never be reused by a subsequent live owner.
      await this.releaseLock(path, record);
    }
  }
  private async acquireLock(): Promise<() => Promise<void>> {
    const path = join(this.directory, ".write-lock"), owner = { pid: process.pid, token: randomUUID() };
    await this.clearDeadRecoveryClaims();
    try {
      const lock = await this.publishLock(path, owner);
      return () => this.releaseLock(path, lock);
    } catch (error) { if (!exists(error)) throw error; }
    const previous = await this.readLock(path);
    if (alive(previous.owner.pid)) throw new Error("LEARNING_LOCK_BUSY");
    const claimPath = join(this.directory, `${recoveryPrefix}${owner.pid}-${owner.token}`);
    const claim = await this.publishLock(claimPath, owner);
    try {
      // Two reapers must not both unlink the old lock: the second unlink could
      // otherwise remove a newly published live lock. Contention fails closed.
      await this.clearDeadRecoveryClaims(claimPath);
      const current = await this.readLock(path);
      if (!sameFile(previous.stat, current.stat) || previous.owner.token !== current.owner.token || previous.owner.pid !== current.owner.pid || alive(current.owner.pid)) throw new Error("LEARNING_LOCK_BUSY");
      await this.releaseLock(path, current);
      const lock = await this.publishLock(path, owner);
      return () => this.releaseLock(path, lock);
    } finally { await this.releaseLock(claimPath, claim); }
  }
  private mutate<T>(work: (records: Experience[]) => T | Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.prepare(true);
      const release = await this.acquireLock();
      try { const records = await this.read(); const result = await work(records); await this.write(records); return result; }
      finally { await release(); }
    });
  }
  async list(): Promise<Experience[]> {
    return this.serial(async () => { try { await this.prepare(false); return await this.read(); } catch (error) { if (missing(error)) return []; throw error; } });
  }
  async addCandidates(inputs: readonly unknown[], now = Date.now()): Promise<Experience[]> {
    if (inputs.length > 20) throw new Error("LEARNING_CANDIDATE_LIMIT");
    const specs = inputs.map(input => { const parsed = CandidateSpecSchema.safeParse(input); if (!parsed.success || parsed.data.expiresAt <= now || parsed.data.expiresAt > now + 90 * 86_400_000) throw new Error("LEARNING_INVALID_CANDIDATE"); return parsed.data; });
    return this.mutate(records => {
      const added: Experience[] = [];
      for (const spec of specs) {
        const existing = records.find(r => r.spec.expiresAt > now && semanticFingerprint(r.spec) === semanticFingerprint(spec));
        if (existing) { added.push(existing); continue; }
        if (records.length >= MAX_RECORDS) {
          const expired = records.findIndex(r => r.spec.expiresAt <= now);
          if (expired < 0) throw new Error("LEARNING_STORE_LIMIT");
          records.splice(expired, 1);
        }
        const value: Experience = { id: randomUUID(), spec, state: "candidate", createdAt: now, successes: 0, failures: 0 };
        records.push(value); added.push(value);
      }
      return deepFreeze(structuredClone(added));
    });
  }
  async validate(id: string, evidence: unknown, now = Date.now()): Promise<Experience> {
    return this.mutate(records => { const record = records.find(r => r.id === id); if (!record || record.state !== "candidate") throw new Error("LEARNING_NOT_CANDIDATE");
      record.validation = validateEvidence(record, evidence, now); record.state = "validated";
      return deepFreeze(structuredClone(record)); });
  }
  async activate(id: string, now = Date.now()): Promise<Experience> {
    return this.mutate(records => { const record = records.find(r => r.id === id);
      if (!record || record.state !== "validated" || !record.validation || record.validation.candidateHash !== candidateHash(record) || record.spec.expiresAt <= now) throw new Error("LEARNING_NOT_VALIDATED");
      if (!record.spec.scope.modelProfile) throw new Error("LEARNING_MODEL_SCOPE_REQUIRED");
      record.state = "active"; return deepFreeze(structuredClone(record)); });
  }
  async disable(id: string): Promise<void> {
    await this.mutate(records => { const record = records.find(r => r.id === id); if (!record) throw new Error("LEARNING_NOT_FOUND"); record.state = "disabled"; });
  }
  async rollback(id: string): Promise<void> { await this.disable(id); }
  async recordOutcome(id: string, outcome: "success" | "failure"): Promise<void> {
    if (!["success", "failure"].includes(outcome)) throw new Error("LEARNING_INVALID_OUTCOME");
    await this.mutate(records => { const record = records.find(r => r.id === id); if (!record) throw new Error("LEARNING_NOT_FOUND");
      if (outcome === "success") record.successes = Math.min(1_000_000, record.successes + 1);
      else { record.failures = Math.min(1_000_000, record.failures + 1); if (record.state === "active") record.state = "disabled"; }
    });
  }
  async loadActive(hostVersion: string, modelFamily?: z.infer<typeof ModelFamilySchema>, now = Date.now(), modelProfile?: string): Promise<FrozenSnapshot> {
    const records = await this.list();
    return deepFreeze(records.filter(r => r.state === "active" && r.spec.expiresAt > now && r.spec.scope.hostVersion === hostVersion
      && !!r.spec.scope.modelProfile && r.spec.scope.modelProfile === modelProfile
      && (!r.spec.scope.modelFamily || r.spec.scope.modelFamily === modelFamily)));
  }
}
