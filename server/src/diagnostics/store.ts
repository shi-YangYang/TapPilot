import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DiagnosticEventSchema, summarizeFailures, type DiagnosticEvent, type FailureSummary } from "./schema.js";

const OWNER = "TapPilot diagnostics schema 1\n";
const DATA = "events.jsonl";
type AppendResult = { stored: true } | { stored: false; reason: "invalid_event" | "queue_full" | "storage_unavailable" | "event_too_large" };
type Channel = { tail: Promise<void>; pending: number };
const channels = new Map<string, Channel>();
export type DiagnosticStoreOptions = { rootDirectory: string; maxBytes?: number; maxRecords?: number; maxQueue?: number };

function limit(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
function missing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

/** A bounded, optional local diagnostic sink. All failures return fixed status
 * values; neither filesystem exception messages nor rejected events are logged.
 * Callers should fire-and-forget append during execution and flush at shutdown.
 * A process lock prevents cross-process read/replace races; a busy writer simply
 * drops this diagnostic event instead of delaying or changing the phone task. */
export class DiagnosticStore {
  readonly directory: string;
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly maxQueue: number;
  private readonly channel: Channel;
  private dropped = 0;
  private unavailable = false;

  constructor(private readonly options: DiagnosticStoreOptions) {
    this.directory = join(resolve(options.rootDirectory), "diagnostics-v1");
    this.maxBytes = limit(options.maxBytes, 512 * 1024, 1024, 16 * 1024 * 1024);
    this.maxRecords = limit(options.maxRecords, 500, 1, 10_000);
    this.maxQueue = limit(options.maxQueue, 32, 1, 256);
    this.channel = channels.get(this.directory) ?? { tail: Promise.resolve(), pending: 0 };
    channels.set(this.directory, this.channel);
  }

  status(): { dropped: number; storageUnavailable: boolean; queued: number } {
    return { dropped: this.dropped, storageUnavailable: this.unavailable, queued: this.channel.pending };
  }

  async append(input: unknown): Promise<AppendResult> {
    let event: DiagnosticEvent;
    // safeParse itself can throw for malicious accessors/proxies. No caller data
    // ever reaches the filesystem unless the entire schema succeeds.
    try {
      const parsed = DiagnosticEventSchema.safeParse(input);
      if (!parsed.success) { this.dropped++; return { stored: false, reason: "invalid_event" }; }
      event = parsed.data;
    } catch { this.dropped++; return { stored: false, reason: "invalid_event" }; }
    const line = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(line) > this.maxBytes) { this.dropped++; return { stored: false, reason: "event_too_large" }; }
    if (this.channel.pending >= this.maxQueue) { this.dropped++; return { stored: false, reason: "queue_full" }; }
    return this.schedule(async () => {
      try {
        await this.ownedDirectory(true);
        await this.withLock(async () => {
          const old = await this.readEvents();
          const lines = [...old, event].slice(-this.maxRecords).map(item => JSON.stringify(item) + "\n");
          let bytes = lines.reduce((sum, item) => sum + Buffer.byteLength(item), 0);
          while (bytes > this.maxBytes && lines.length) bytes -= Buffer.byteLength(lines.shift()!);
          await this.replace(lines.join(""));
        });
        this.unavailable = false;
        return { stored: true } as const;
      } catch {
        this.dropped++; this.unavailable = true;
        return { stored: false, reason: "storage_unavailable" } as const;
      }
    });
  }

  async list(): Promise<DiagnosticEvent[]> {
    return this.schedule(async () => {
      try { await this.ownedDirectory(false); const events = await this.readEvents(); this.unavailable = false; return events; }
      catch (error) { if (!missing(error)) this.unavailable = true; return []; }
    });
  }

  async summarize(): Promise<FailureSummary[]> { return summarizeFailures(await this.list()); }

  /** Only this schema's data file is removed; unrelated files and directories,
   * ownership markers, and any symlink destination are never deleted. */
  async clear(): Promise<{ cleared: boolean }> {
    return this.schedule(async () => {
      try {
        await this.ownedDirectory(false);
        await this.withLock(async () => {
          try { await this.checkedFile(join(this.directory, DATA)); await unlink(join(this.directory, DATA)); }
          catch (error) { if (!missing(error)) throw error; }
        });
        this.unavailable = false;
        return { cleared: true };
      } catch (error) { if (!missing(error)) this.unavailable = true; return { cleared: false }; }
    });
  }

  async flush(): Promise<void> { await this.channel.tail; }

  private schedule<T>(work: () => Promise<T>): Promise<T> {
    this.channel.pending++;
    const operation = this.channel.tail.then(work);
    this.channel.tail = operation.then(() => {}, () => {}).finally(() => { this.channel.pending--; });
    return operation;
  }

  private async ownedDirectory(create: boolean): Promise<void> {
    const root = resolve(this.options.rootDirectory);
    // The enclosing app-data directory belongs to the caller. Never create or
    // recursively chmod arbitrary parents and never follow a final symlink.
    const parent = await lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("unsafe_root");
    let created = false;
    if (create) {
      try { await mkdir(this.directory, { mode: 0o700 }); created = true; }
      catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe_directory");
    const ownerFile = join(this.directory, ".owner");
    if (created) {
      const handle = await open(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(OWNER); } finally { await handle.close(); }
    }
    await this.checkedFile(ownerFile, 128);
    const handle = await open(ownerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (await handle.readFile("utf8") !== OWNER) throw new Error("foreign_directory"); } finally { await handle.close(); }
    await chmod(this.directory, 0o700);
    await chmod(ownerFile, 0o600);
  }

  private async checkedFile(path: string, maxBytes = this.maxBytes): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("unsafe_file");
  }

  private async readEvents(): Promise<DiagnosticEvent[]> {
    const path = join(this.directory, DATA);
    try { await this.checkedFile(path); } catch (error) { if (missing(error)) return []; throw error; }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.maxBytes) throw new Error("unsafe_file");
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > this.maxBytes) throw new Error("oversized_file");
      const result: DiagnosticEvent[] = [];
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const parsed = DiagnosticEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) result.push(parsed.data);
        } catch { /* A partial/corrupt record is not evidence. */ }
      }
      return result.slice(-this.maxRecords);
    } finally { await handle.close(); }
  }

  private async replace(content: string): Promise<void> {
    const path = join(this.directory, DATA);
    try { await this.checkedFile(path); } catch (error) { if (!missing(error)) throw error; }
    const temporary = join(this.directory, `.events-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    finally { await handle.close(); }
    try { await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const path = join(this.directory, ".write-lock");
    // Lock content is an OS process ID, not device/user data. Recover only a
    // dead process's lock; a live or ambiguous owner causes a bounded refusal.
    try {
      await this.checkedFile(path, 32);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: string;
      try { value = await handle.readFile("utf8"); } finally { await handle.close(); }
      if (/^[1-9]\d{0,9}\n$/.test(value)) {
        try { process.kill(Number(value.trim()), 0); }
        catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") await unlink(path); }
      }
    } catch (error) { if (!missing(error)) throw error; }
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${process.pid}\n`); return await work(); }
    finally { await handle.close(); await unlink(path).catch(() => {}); }
  }
}
