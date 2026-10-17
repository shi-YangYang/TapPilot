import { constants, type Stats } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// Keep the schema and publication/recovery protocol compatible with the JSON
// store. Migration must exclude a still-running older process before reading it.
const lockSchema = z.object({ pid: z.number().int().min(1).max(2_147_483_647), token: z.string().uuid() }).strict();
type LockOwner = z.infer<typeof lockSchema>;
type LockRecord = { owner: LockOwner; stat: Stats };
const recoveryPrefix = ".write-recovery-";
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
const exists = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
const sameFile = (first: Stats, second: Stats) => first.ino === second.ino && first.dev === second.dev;
const fixed = (error: unknown) => new Error(error instanceof Error && /^SKILLS_[A-Z_]+$/.test(error.message) ? error.message : "SKILLS_STORAGE_UNAVAILABLE");
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH"; }
}

class LegacyLock {
  constructor(private readonly directory: string) {}

  private async readLock(path: string): Promise<LockRecord> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 512 || process.getuid && before.uid !== process.getuid()) throw new Error("SKILLS_UNSAFE_LOCK");
    // Publication followed by a crash can leave the temporary second link.
    if (before.nlink < 1 || before.nlink > 2) throw new Error("SKILLS_UNSAFE_LOCK");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!sameFile(before, stat) || !stat.isFile() || stat.nlink < 1 || stat.nlink > 2 || stat.size > 512) throw new Error("SKILLS_UNSAFE_LOCK");
      const parsed = lockSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
      if (!parsed.success) throw new Error("SKILLS_UNSAFE_LOCK");
      return { owner: parsed.data, stat };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("SKILLS_UNSAFE_LOCK");
      throw error;
    } finally { await handle.close(); }
  }

  private async publishLock(path: string, owner: LockOwner): Promise<LockRecord> {
    const temporary = join(this.directory, `.lock-publish-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner)); await handle.sync();
      // Publish a complete immutable owner record atomically, never an empty lock.
      await link(temporary, path);
    } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
    return this.readLock(path);
  }

  private async releaseLock(path: string, expected: LockRecord): Promise<void> {
    const current = await this.readLock(path);
    if (!sameFile(current.stat, expected.stat) || current.owner.pid !== expected.owner.pid || current.owner.token !== expected.owner.token) throw new Error("SKILLS_LOCK_OWNERSHIP_CHANGED");
    await unlink(path);
  }

  private async clearDeadRecoveryClaims(ownPath?: string): Promise<void> {
    for (const name of await readdir(this.directory)) {
      if (!name.startsWith(recoveryPrefix)) continue;
      const path = join(this.directory, name);
      if (path === ownPath) continue;
      const match = /^\.write-recovery-([1-9]\d*)-([a-f\d-]{36})$/.exec(name);
      if (!match) throw new Error("SKILLS_UNSAFE_LOCK");
      let record: LockRecord;
      try { record = await this.readLock(path); } catch (error) { if (missing(error)) continue; throw error; }
      if (record.owner.pid !== Number(match[1]) || record.owner.token !== match[2]) throw new Error("SKILLS_UNSAFE_LOCK");
      if (alive(record.owner.pid)) throw new Error("SKILLS_LOCK_BUSY");
      // Claims have unique owner-token paths, unlike the shared lock path.
      await this.releaseLock(path, record);
    }
  }

  async acquire(): Promise<() => Promise<void>> {
    const path = join(this.directory, ".write-lock"), owner = { pid: process.pid, token: randomUUID() };
    await this.clearDeadRecoveryClaims();
    try {
      const lock = await this.publishLock(path, owner);
      return () => this.releaseLock(path, lock);
    } catch (error) { if (!exists(error)) throw error; }
    const previous = await this.readLock(path);
    if (alive(previous.owner.pid)) throw new Error("SKILLS_LOCK_BUSY");
    const claimPath = join(this.directory, `${recoveryPrefix}${owner.pid}-${owner.token}`);
    const claim = await this.publishLock(claimPath, owner);
    try {
      // Competing reapers must fail closed rather than unlink a new live owner.
      await this.clearDeadRecoveryClaims(claimPath);
      const current = await this.readLock(path);
      if (!sameFile(previous.stat, current.stat) || previous.owner.token !== current.owner.token || previous.owner.pid !== current.owner.pid || alive(current.owner.pid)) throw new Error("SKILLS_LOCK_BUSY");
      await this.releaseLock(path, current);
      const lock = await this.publishLock(path, owner);
      return () => this.releaseLock(path, lock);
    } finally { await this.releaseLock(claimPath, claim); }
  }
}

/** The caller validates the private directory before acquiring this migration-only lock. */
export async function acquireLegacyLock(directory: string): Promise<() => Promise<void>> {
  try {
    const release = await new LegacyLock(directory).acquire();
    return async () => { try { await release(); } catch (error) { throw fixed(error); } };
  } catch (error) { throw fixed(error); }
}
