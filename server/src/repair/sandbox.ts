import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileProjection } from "./candidate.js";
import { RepairError } from "./schema.js";

const RUNNER = `'use strict';
const readline = require('node:readline');
const project = require('./projection.cjs').projectToolResult;
const stringify = JSON.stringify.bind(JSON);
const write = process.stdout.write.bind(process.stdout);
readline.createInterface({ input: process.stdin, terminal: false }).on('line', line => {
 try { const value = JSON.parse(line); const output = project(value.input); write(stringify({ id: value.id, output }) + '\\n'); }
 catch { write('{"error":"PROJECTION_FAILED"}\\n'); }
});`;
const quote = (value: string) => JSON.stringify(value);
function profile(directory: string, node: string): string {
  const parents = new Set<string>();
  let parent = dirname(directory);
  while (!parents.has(parent)) { parents.add(parent); if (parent === "/") break; parent = dirname(parent); }
  return `(version 1)(deny default)
(allow process-exec (literal ${quote(node)}))
(allow file-read* ${[...parents].map(path => `(literal ${quote(path)})`).join(" ")} (subpath ${quote(directory)}) (subpath "/System") (subpath "/usr/lib") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (subpath ${quote(join(directory, "scratch"))}))
(allow sysctl-read)
(deny network*)(deny process-fork)`;
}
export class ProjectionSandbox {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending?: { id: number; resolve: (value: unknown) => void; reject: (error: RepairError) => void; timer: NodeJS.Timeout };
  private buffer = "";
  private terminated = false;
  private verified = false;
  private wall?: NodeJS.Timeout;
  private constructor(readonly directory: string, private readonly binary: string, private readonly policy: string, private readonly budgetMs: number) {}

  static async create(source: string, budgetMs: number): Promise<ProjectionSandbox> {
    if (process.platform !== "darwin") throw new RepairError("SANDBOX_UNAVAILABLE");
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tappilot-repair-")));
    await chmod(directory, 0o700);
    try {
      const binary = join(directory, "node");
      await copyFile(process.execPath, binary, constants.COPYFILE_FICLONE);
      await chmod(binary, 0o500);
      await mkdir(join(directory, "scratch"), { mode: 0o700 });
      await writeFile(join(directory, "projection.cjs"), compileProjection(source), { mode: 0o400 });
      await writeFile(join(directory, "runner.cjs"), RUNNER, { mode: 0o400 });
      const policy = profile(directory, binary);
      await writeFile(join(directory, "sandbox.sb"), policy, { mode: 0o400 });
      return new ProjectionSandbox(directory, binary, policy, Math.min(120_000, Math.max(1000, budgetMs)));
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  private env(): NodeJS.ProcessEnv { return { PATH: "/usr/bin:/bin", HOME: this.directory, TMPDIR: join(this.directory, "scratch"), LANG: "C", NODE_DISABLE_COMPILE_CACHE: "1" }; }

  /** A fixed trusted probe verifies denial, not just sandbox-exec availability.
   * It checks an existing synthetic canary outside the candidate directory,
   * loopback network and child processes before any candidate module is loaded. */
  async verify(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RepairError("TIME_BUDGET");
    const outside = await realpath(await mkdtemp(join(tmpdir(), "tappilot-canary-")));
    const canary = join(outside, "synthetic.txt");
    await writeFile(canary, "synthetic-canary", { mode: 0o600 });
    const code = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');let file=false,child=false;
try{fs.readFileSync(${quote(canary)})}catch(e){file=['EPERM','EACCES'].includes(e.code)}
const c=cp.spawnSync(process.execPath,['-e','process.exit(0)']);child=Boolean(c.error&&['EPERM','EACCES'].includes(c.error.code));
const s=net.connect(9,'127.0.0.1');s.on('connect',()=>{process.exitCode=1;s.destroy()});s.on('error',e=>{process.stdout.write(JSON.stringify({file,child,network:['EPERM','EACCES'].includes(e.code),clean:!process.env.TAPPILOT_MODEL_KEY}));});`;
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn("/usr/bin/sandbox-exec", ["-p", this.policy, this.binary, "--max-old-space-size=128", "-e", code], { cwd: this.directory, env: this.env(), stdio: ["pipe", "pipe", "pipe"], detached: true });
        let output = "";
        const fail = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} reject(new RepairError("SANDBOX_UNAVAILABLE")); };
        const timer = setTimeout(fail, Math.min(10_000, this.budgetMs));
        signal?.addEventListener("abort", fail, { once: true });
        child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 1024) { child.kill("SIGKILL"); reject(new RepairError("SANDBOX_UNAVAILABLE")); } });
        child.stderr.resume();
        child.on("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", fail); reject(new RepairError("SANDBOX_UNAVAILABLE")); });
        child.on("close", exit => { clearTimeout(timer); signal?.removeEventListener("abort", fail); exit === 0 ? resolve(output) : reject(new RepairError("SANDBOX_UNAVAILABLE")); });
      });
      const check = JSON.parse(result);
      if (check.file !== true || check.child !== true || check.network !== true || check.clean !== true) throw new RepairError("SANDBOX_UNAVAILABLE");
      this.verified = true;
    } catch { throw new RepairError("SANDBOX_UNAVAILABLE"); }
    finally { await rm(outside, { recursive: true, force: true }); }
  }
  start(): void {
    if (this.child || this.terminated || !this.verified) throw new RepairError("SANDBOX_STATE");
    this.child = spawn("/usr/bin/sandbox-exec", ["-p", this.policy, this.binary, "--max-old-space-size=128", join(this.directory, "runner.cjs")], { cwd: this.directory, env: this.env(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.wall = setTimeout(() => this.stop(new RepairError("CANDIDATE_TIMEOUT")), this.budgetMs);
    this.child.stderr.resume(); // Raw candidate output is never logged or persisted.
    this.child.on("error", () => this.stop(new RepairError("SANDBOX_UNAVAILABLE")));
    this.child.on("close", () => this.stop(new RepairError("CANDIDATE_EXITED")));
    this.child.stdout.on("data", chunk => {
      this.buffer += String(chunk);
      if (this.buffer.length > 512 * 1024) { this.stop(new RepairError("CANDIDATE_OUTPUT_LIMIT")); return; }
      let position: number;
      while ((position = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, position); this.buffer = this.buffer.slice(position + 1);
        try {
          const value = JSON.parse(line), pending = this.pending;
          if (!pending || value.id !== pending.id || Object.keys(value).sort().join(",") !== "id,output") throw new Error();
          this.pending = undefined; clearTimeout(pending.timer); pending.resolve(value.output);
        } catch { this.stop(new RepairError("CANDIDATE_PROTOCOL_ERROR")); }
      }
    });
  }
  async project(input: unknown): Promise<unknown> {
    if (!this.child || this.pending || this.terminated) throw new RepairError("SANDBOX_STATE");
    const line = JSON.stringify({ id: ++this.sequence, input }) + "\n";
    if (Buffer.byteLength(line) > 512 * 1024) throw new RepairError("SYNTHETIC_INPUT_LIMIT");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new RepairError("CANDIDATE_TIMEOUT")), 1500);
      this.pending = { id: this.sequence, resolve, reject, timer };
      this.child!.stdin.write(line, error => { if (error) this.stop(new RepairError("CANDIDATE_EXITED")); });
    });
  }
  private stop(error: RepairError): void {
    this.terminated = true;
    if (this.wall) clearTimeout(this.wall);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
    if (this.child?.pid) { try { process.kill(-this.child.pid, "SIGKILL"); } catch {} }
  }
  async close(): Promise<void> { this.stop(new RepairError("CANDIDATE_CLOSED")); await rm(this.directory, { recursive: true, force: true }); }
}
