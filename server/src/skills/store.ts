import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { deepFreeze } from "../learning/schema.js";
import { SkillSpecSchema, SkillScopeSchema, SkillFeedbackSchema, SkillHashSchema, skillHash, semanticSkillHash, matchesScope, type SkillSpec, type SkillScope, type SkillFeedback } from "./schema.js";
import { FailureEpisodeSchema, episodeFingerprint, type FailureEpisode } from "./trace.js";
import { SkillValidationSchema, verifySkillReceipt, type SkillReceipt } from "./evaluation.js";

const MAX_BYTES = 2 * 1024 * 1024;
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const counter = z.number().int().nonnegative().max(1_000_000);
const JobSchema = z.object({
  id: z.string().uuid(), episodeId: z.string().uuid(), fingerprint: SkillHashSchema,
  state: z.enum(["queued", "running", "interrupted", "adopted", "rejected", "cancelled", "exhausted"]),
  createdAt: timestamp, startedAt: timestamp.optional(), finishedAt: timestamp.optional(),
  ownerPid: z.number().int().positive().optional(), candidateHashes: z.array(SkillHashSchema).max(2),
  feedback: z.array(SkillFeedbackSchema).max(2), modelCalls: counter,
}).strict();
export type SkillJob = z.infer<typeof JobSchema>;
const RecordSchema = z.object({ spec: SkillSpecSchema, hash: SkillHashSchema,
  state: z.enum(["candidate", "active", "superseded", "revoked", "rejected"]),
  jobId: z.string().uuid(), createdAt: timestamp, successes: counter, failures: counter,
  validation: SkillValidationSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.hash !== skillHash(record.spec) || record.validation && record.validation.skillHash !== record.hash || ["active", "superseded"].includes(record.state) && !record.validation)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_skill_validation" });
});
const StateSchema = z.object({schemaVersion: z.literal(1), enabled: z.boolean(),
  episodes: z.array(FailureEpisodeSchema).max(64), jobs: z.array(JobSchema).max(64), skills: z.array(RecordSchema).max(128),
  daily: z.object({day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), jobs: z.number().int().min(0).max(2), modelCalls: z.number().int().min(0).max(200)}).strict(),
}).strict();
type StoreState = z.infer<typeof StateSchema>;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const initialState = (): StoreState => ({schemaVersion: 1, enabled: true, episodes: [], jobs: [], skills: [], daily: {day: day(Date.now()), jobs: 0, modelCalls: 0}});
const OWNER = "TapPilot procedural skills schema 1\n";
const channels = new Map<string, Promise<unknown>>();
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
const exists = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
const fixed = (error: unknown) => new Error(error instanceof Error && /^SKILLS_[A-Z_]+$/.test(error.message) ? error.message : "SKILLS_STORAGE_UNAVAILABLE");
const lockSchema = z.object({ pid: z.number().int().min(1).max(2_147_483_647), token: z.string().uuid() }).strict();
type LockOwner = z.infer<typeof lockSchema>;
type LockRecord = { owner: LockOwner; stat: Stats };
const recoveryPrefix = ".write-recovery-";
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH"; }
}
const sameFile = (first: Stats, second: Stats) => first.ino === second.ino && first.dev === second.dev;
class PrivateSkillState {
  readonly directory: string;
  constructor(readonly rootDirectory: string) { this.directory = join(resolve(rootDirectory), "skills-v1"); }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = channels.get(this.directory) ?? Promise.resolve();
    const current = previous.then(work, work);
    channels.set(this.directory, current.catch(() => {}));
    try { return await current; } catch (error) { throw fixed(error); }
  }
  private async file(path: string, max = MAX_BYTES) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw new Error("SKILLS_UNSAFE_STORAGE");
  }
  private async prepare(create: boolean) {
    const root = await lstat(resolve(this.rootDirectory));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("SKILLS_UNSAFE_STORAGE");
    let created = false;
    if (create) try { await mkdir(this.directory, { mode: 0o700 }); created = true; }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("SKILLS_UNSAFE_STORAGE");
    const path = join(this.directory, ".owner");
    if (created) { const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(OWNER); } finally { await handle.close(); } }
    await this.file(path, 128);
    const owner = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (await owner.readFile("utf8") !== OWNER) throw new Error("SKILLS_UNSAFE_STORAGE"); } finally { await owner.close(); }
    await chmod(this.directory, 0o700); await chmod(path, 0o600);
  }
  private async read(): Promise<StoreState> {
    const path = join(this.directory, "state.json");
    try { await this.file(path); } catch (error) { if (missing(error)) return initialState(); throw error; }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("SKILLS_UNSAFE_STORAGE");
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("SKILLS_STORE_LIMIT");
      const records = StateSchema.safeParse(JSON.parse(text));
      if (!records.success) throw new Error("SKILLS_INVALID_STORE");
      return records.data;
    } finally { await handle.close(); }
  }
  private async write(records: StoreState) {
    const validated = StateSchema.safeParse(records);
    if (!validated.success) throw new Error("SKILLS_INVALID_STORE");
    const content = JSON.stringify(validated.data);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("SKILLS_STORE_LIMIT");
    const destination = join(this.directory, "state.json");
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
    if (!before.isFile() || before.isSymbolicLink() || before.size > 512 || process.getuid && before.uid !== process.getuid()) throw new Error("SKILLS_UNSAFE_LOCK");
    // A crash between publication and temporary-file cleanup can leave the
    // second link. Metadata stays complete and recoverable; it is never written.
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
      // Unlike an empty O_EXCL lock file, the published owner is complete even
      // if the process exits immediately after acquiring the lock.
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
    if (alive(previous.owner.pid)) throw new Error("SKILLS_LOCK_BUSY");
    const claimPath = join(this.directory, `${recoveryPrefix}${owner.pid}-${owner.token}`);
    const claim = await this.publishLock(claimPath, owner);
    try {
      // Two reapers must not both unlink the old lock: the second unlink could
      // otherwise remove a newly published live lock. Contention fails closed.
      await this.clearDeadRecoveryClaims(claimPath);
      const current = await this.readLock(path);
      if (!sameFile(previous.stat, current.stat) || previous.owner.token !== current.owner.token || previous.owner.pid !== current.owner.pid || alive(current.owner.pid)) throw new Error("SKILLS_LOCK_BUSY");
      await this.releaseLock(path, current);
      const lock = await this.publishLock(path, owner);
      return () => this.releaseLock(path, lock);
    } finally { await this.releaseLock(claimPath, claim); }
  }
  mutate<T>(work: (state: StoreState) => T | Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.prepare(true); const release = await this.acquireLock();
      try { const state = await this.read(); const result = await work(state); await this.write(state); return result; }
      finally { await release(); }
    });
  }
  list(): Promise<StoreState> { return this.serial(async () => {
    try { await this.prepare(false); return await this.read(); } catch (error) { if (missing(error)) return initialState(); throw error; }
  }); }
}

export type StoreStatus = { enabled: boolean; activeSkills: number; queued: number; dailyJobs: number; dailyModelCalls: number };
function resetDay(state: StoreState, now: number) { if (state.daily.day !== day(now)) state.daily = {day: day(now), jobs: 0, modelCalls: 0}; }
function sameSlot(a: SkillSpec, b: SkillSpec) { return JSON.stringify(a.scope) === JSON.stringify(b.scope) && JSON.stringify(a.trigger) === JSON.stringify(b.trigger); }
function trim(state: StoreState) {
  // A fixed-size ledger retains the recent evidence fingerprints and never evicts a running job or an active winner.
  while (state.jobs.length > 64) {
    const index = state.jobs.findIndex(job => !["running", "queued"].includes(job.state));
    if (index < 0) throw new Error("SKILLS_STORE_LIMIT");
    state.jobs.splice(index, 1);
  }
  const referenced = new Set(state.jobs.map(job => job.episodeId));
  state.episodes = state.episodes.filter(episode => referenced.has(episode.id));
  while (state.skills.length > 128) {
    const index = state.skills.findIndex(record => ["rejected", "revoked"].includes(record.state));
    if (index < 0) throw new Error("SKILLS_STORE_LIMIT");
    state.skills.splice(index, 1);
  }
}

function revokeSkills(state:StoreState, hashes:readonly string[], now:number){
  const records=hashes.flatMap(hash=>{const record=state.skills.find(r=>r.hash===hash);return record?[record]:[];});
  // Revoke the complete original set before restoring ancestors. An ancestor
  // that is itself being withdrawn must never be reactivated by ordering.
  for(const record of records){record.failures=Math.min(1_000_000,record.failures+1);record.state="revoked";}
  for(const record of records){let ancestorHash=record.spec.lineage.parentHash;const visited=new Set<string>();
    while(ancestorHash&&!visited.has(ancestorHash)){visited.add(ancestorHash);const ancestor=state.skills.find(r=>r.hash===ancestorHash);if(!ancestor)break;
      if(ancestor.state==="superseded"&&ancestor.failures===0&&ancestor.validation&&ancestor.spec.expiresAt>now&&sameSlot(ancestor.spec,record.spec)){
        if(!state.skills.some(r=>r.state==="active"&&sameSlot(r.spec,ancestor.spec)))ancestor.state="active";break;
      }ancestorHash=ancestor.spec.lineage.parentHash;
    }
  }
}

/** Persistence accepts only closed-schema structural facts and procedural programs.
 * API keys, task prose, UI labels and model responses have no representable fields. */
export class SkillStore {
  readonly directory: string;
  private readonly privateState: PrivateSkillState;
  constructor(rootDirectory: string) { this.privateState = new PrivateSkillState(rootDirectory); this.directory = this.privateState.directory; }
  async status(now = Date.now()): Promise<StoreStatus> {
    const state = await this.privateState.list();
    return {enabled: state.enabled, activeSkills: state.skills.filter(r=>r.state === "active" && r.spec.expiresAt > now).length,
      queued: state.jobs.filter(j=>j.state === "queued").length,
      dailyJobs: state.daily.day === day(now) ? state.daily.jobs : 0, dailyModelCalls: state.daily.day === day(now) ? state.daily.modelCalls : 0};
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("SKILLS_INVALID_STATE");
    await this.privateState.mutate(state => { state.enabled = enabled; if (!enabled) for (const job of state.jobs) if (job.state === "queued") { job.state = "cancelled"; job.finishedAt = Date.now(); } });
  }
  async loadSnapshot(scope: SkillScope, now = Date.now()): Promise<readonly SkillSpec[]> {
    const current = SkillScopeSchema.parse(scope), state = await this.privateState.list();
    if (!state.enabled) return Object.freeze([]);
    return deepFreeze(state.skills.filter(r=>r.state === "active" && r.spec.expiresAt > now && matchesScope(r.spec.scope,current))
      .sort((a,b)=>b.successes-a.successes || b.createdAt-a.createdAt).slice(0,3).map(r=>structuredClone(r.spec)));
  }
  async loadTaskSnapshot(scope: SkillScope, now = Date.now()): Promise<readonly SkillSpec[]> {
    const current = SkillScopeSchema.parse(scope), state = await this.privateState.list();
    if (!state.enabled) return Object.freeze([]);
    return deepFreeze(state.skills.filter(r=>r.state === "active" && r.spec.expiresAt > now
      && r.spec.scope.hostVersion===current.hostVersion && r.spec.scope.policyRevision===current.policyRevision && r.spec.scope.modelProfile===current.modelProfile)
      .sort((a,b)=>b.successes-a.successes || b.createdAt-a.createdAt).slice(0,64).map(r=>structuredClone(r.spec)));
  }
  async recordEpisode(input: unknown, now = Date.now()): Promise<{id: string; queued: boolean}> {
    const parsed = FailureEpisodeSchema.safeParse(input); if (!parsed.success) throw new Error("SKILLS_INVALID_EPISODE");
    const episode = parsed.data, fingerprint = createHash("sha256").update(JSON.stringify([episodeFingerprint(episode),episode.appliedSkillHashes])).digest("hex");
    return this.privateState.mutate(state => {
      const previous = state.jobs.find(job=>job.fingerprint === fingerprint);
      if (previous) return {id: previous.id, queued: false};
      const queued = state.enabled && episode.termination !== "cancelled" && episode.steps.some(step=>!["NONE", "UNKNOWN"].includes(step.errorCode));
      const job: SkillJob = {id:randomUUID(),episodeId:episode.id,fingerprint,state:queued?"queued":"cancelled",createdAt:now,candidateHashes:[],feedback:[],modelCalls:0};
      if (state.episodes.some(e=>e.id === episode.id)) throw new Error("SKILLS_DUPLICATE_EPISODE");
      state.episodes.push(episode); state.jobs.push(job); trim(state); return {id:job.id,queued};
    });
  }
  async recoverInterrupted(now=Date.now()):Promise<void>{
    await this.privateState.mutate(state=>{for(const job of state.jobs)if(job.state==="running"&&(!job.ownerPid||!alive(job.ownerPid))){
      job.state="interrupted";job.finishedAt=now;
      for(const record of state.skills)if(record.jobId===job.id&&record.state==="candidate")record.state="rejected";
    }});
  }
  async beginJob(modelProfile: string, now = Date.now()): Promise<{job: SkillJob; episode: FailureEpisode; parent?: SkillSpec} | undefined> {
    SkillHashSchema.parse(modelProfile);
    return this.privateState.mutate(state => {
      resetDay(state,now);
      // A process crash consumes its reserved daily budget. It never restarts an unknown partially evaluated candidate.
      for (const job of state.jobs) if (job.state === "running" && (!job.ownerPid || !alive(job.ownerPid))) {job.state="interrupted";job.finishedAt=now;}
      if (!state.enabled || state.jobs.some(j=>j.state === "running") || state.daily.jobs >= 2 || state.daily.modelCalls >= 200) return undefined;
      const job = state.jobs.find(j=>j.state === "queued" && state.episodes.find(e=>e.id===j.episodeId)?.scope.modelProfile===modelProfile);
      if (!job) return undefined;
      const episode = state.episodes.find(e=>e.id===job.episodeId)!;
      job.state="running"; job.startedAt=now; job.ownerPid=process.pid; state.daily.jobs++;
      const used = episode.appliedSkillHashes.map(hash=>state.skills.find(s=>s.hash===hash && JSON.stringify(s.spec.scope)===JSON.stringify(episode.scope) && JSON.stringify(s.spec.trigger)===JSON.stringify(episode.trigger))).find(Boolean);
      const active = state.skills.filter(r=>r.state==="active" && r.spec.expiresAt>now && matchesScope(r.spec.scope,episode.scope)
        && JSON.stringify(r.spec.trigger)===JSON.stringify(episode.trigger)).sort((a,b)=>b.createdAt-a.createdAt)[0];
      return deepFreeze({job:structuredClone(job),episode:structuredClone(episode),...((used??active)?{parent:structuredClone((used??active)!.spec)}:{})});
    });
  }
  async reserveModelCall(jobId: string, now = Date.now()): Promise<void> {
    await this.privateState.mutate(state=>{resetDay(state,now);const job=state.jobs.find(j=>j.id===jobId);
      if (!job || job.state!=="running" || !state.enabled) throw new Error("SKILLS_JOB_CANCELLED");
      if (job.modelCalls>=100 || state.daily.modelCalls>=200) throw new Error("SKILLS_BUDGET_EXHAUSTED");
      job.modelCalls++;state.daily.modelCalls++;
    });
  }
  async addCandidate(jobId: string,input: unknown,now=Date.now()): Promise<string> {
    const spec=SkillSpecSchema.parse(input),hash=skillHash(spec);
    return this.privateState.mutate(state=>{const job=state.jobs.find(j=>j.id===jobId),episode=state.episodes.find(e=>e.id===job?.episodeId);
      if (!job || job.state!=="running" || !episode) throw new Error("SKILLS_JOB_CANCELLED");
      if (job.candidateHashes.length>=2 || spec.expiresAt<=now || spec.expiresAt>now+90*86_400_000 || JSON.stringify(spec.scope)!==JSON.stringify(episode.scope)
        || JSON.stringify(spec.trigger)!==JSON.stringify(episode.trigger)) throw new Error("SKILLS_INVALID_CANDIDATE");
      if (state.skills.some(r=>semanticSkillHash(r.spec)===semanticSkillHash(spec))) throw new Error("SKILLS_DUPLICATE_CANDIDATE");
      if (spec.lineage.parentHash && !state.skills.some(r=>r.hash===spec.lineage.parentHash)) throw new Error("SKILLS_UNKNOWN_PARENT");
      job.candidateHashes.push(hash);state.skills.push({spec,hash,state:"candidate",jobId,createdAt:now,successes:0,failures:0});trim(state);return hash;
    });
  }
  async rejectCandidate(jobId: string, input: SkillFeedback): Promise<void> {
    const feedback=SkillFeedbackSchema.parse(input);
    await this.privateState.mutate(state=>{const job=state.jobs.find(j=>j.id===jobId),record=state.skills.find(r=>r.hash===feedback.skillHash && r.jobId===jobId);
      if (!job || job.state!=="running" || !record || record.state!=="candidate") throw new Error("SKILLS_NOT_CANDIDATE");
      record.state="rejected";job.feedback.push(feedback);
    });
  }
  async adopt(jobId: string, hash: string, receipt: SkillReceipt, now=Date.now()): Promise<void> {
    await this.privateState.mutate(state=>{const job=state.jobs.find(j=>j.id===jobId),record=state.skills.find(r=>r.hash===hash&&r.jobId===jobId),episode=state.episodes.find(e=>e.id===job?.episodeId);
      if (!state.enabled || !job || job.state!=="running" || !record || record.state!=="candidate" || !episode || record.spec.expiresAt<=now) throw new Error("SKILLS_NOT_CANDIDATE");
      const validation=verifySkillReceipt(record.spec,episode,receipt);
      const incumbents=state.skills.filter(r=>r.state==="active"&&r.spec.expiresAt>now&&matchesScope(r.spec.scope,episode.scope))
        .sort((a,b)=>b.successes-a.successes||b.createdAt-a.createdAt).slice(0,3).map(r=>r.hash).sort();
      if(JSON.stringify(incumbents)!==JSON.stringify([...validation.incumbentHashes].sort()))throw new Error("SKILLS_INCUMBENT_CHANGED");
      for (const other of state.skills) if (other.state==="active" && sameSlot(other.spec,record.spec)) other.state="superseded";
      record.validation=validation;record.state="active";job.state="adopted";job.finishedAt=now;
    });
  }
  async finishJob(jobId: string, result: "interrupted"|"rejected"|"cancelled"|"exhausted", now=Date.now()): Promise<void> {
    await this.privateState.mutate(state=>{const job=state.jobs.find(j=>j.id===jobId);if (!job||job.state!=="running") return;
      job.state=result;job.finishedAt=now;for(const record of state.skills)if(record.jobId===jobId&&record.state==="candidate")record.state="rejected";
    });
  }
  async cancelQueued(now=Date.now()): Promise<void> {
    await this.privateState.mutate(state=>{for(const job of state.jobs)if(job.state==="queued"){job.state="cancelled";job.finishedAt=now;}});
  }
  async recordUsageOutcome(hashes: readonly string[], outcome: "success"|"failure", now=Date.now()): Promise<void> {
    const checked=z.array(SkillHashSchema).max(3).parse(hashes);
    if (!["success","failure"].includes(outcome)) throw new Error("SKILLS_INVALID_OUTCOME");
    await this.privateState.mutate(state=>{
      if(outcome==="failure"){revokeSkills(state,checked,now);return;}
      for(const hash of checked){const record=state.skills.find(r=>r.hash===hash);if(record)record.successes=Math.min(1_000_000,record.successes+1);}
    });
  }
  async rollback(now=Date.now()): Promise<void> {
    await this.privateState.mutate(state=>revokeSkills(state,state.skills.filter(r=>r.state==="active").map(r=>r.hash),now));
  }
  async history(): Promise<{jobs: readonly SkillJob[]; skills: readonly {hash:string;state:string}[]}> {
    const state=await this.privateState.list();return deepFreeze({jobs:structuredClone(state.jobs),skills:state.skills.map(r=>({hash:r.hash,state:r.state}))});
  }
}
