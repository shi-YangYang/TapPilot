import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Keep callers alive until the test releases them, so a claim race does not
 * accidentally become dead-owner recovery between differently timed workers. */
export async function startSkillWorker(root: string, operation: "claim" | "reserve", args: Record<string, unknown>) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("./skills-worker.ts", import.meta.url)), root, operation, JSON.stringify(args)],
  { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let resultResolve!: (value: any) => void, resultReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise<any>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  // A startup failure can reject both promises before the caller starts a run.
  void result.catch(() => {});
  const exited = new Promise<void>(resolve => child.once("close", () => {
    const error = new Error(`Skill test worker exited: ${stderr}`);
    readyReject(error); resultReject(error); resolve();
  }));
  child.once("error", error => { readyReject(error); resultReject(error); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      if (message.type === "ready") readyResolve();
      else if (message.type === "result") resultResolve(message.value);
    } catch { readyReject(new Error("Invalid skill test worker output")); }
  });
  const startup = setTimeout(() => { readyReject(new Error("Skill test worker startup timed out")); child.kill("SIGKILL"); }, 10_000);
  try { await ready; } finally { clearTimeout(startup); }
  return {
    pid: child.pid!,
    run: async () => {
      const deadline = setTimeout(() => { resultReject(new Error("Skill test worker operation timed out")); child.kill("SIGKILL"); }, 10_000);
      child.stdin.write("run\n");
      try { return await result; } finally { clearTimeout(deadline); }
    },
    close: async () => { if (child.exitCode === null && child.signalCode === null) child.stdin.write("close\n"); await exited; lines.close(); },
    kill: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; lines.close(); },
  };
}
