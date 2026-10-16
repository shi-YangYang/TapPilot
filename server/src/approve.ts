import { connect } from "node:net";
import { createInterface } from "node:readline/promises";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

async function command(socketPath: string, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Approval connection timed out.")), 5_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("error", () => finish(new Error("Cannot connect to the approval socket. The request may have expired.")));
    socket.on("close", () => { if (!settled) finish(new Error("Approval socket closed without a response.")); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 256 * 1024) return finish(new Error("Approval response is too large."));
      if (!buffer.includes("\n")) return;
      try { finish(undefined, JSON.parse(buffer)); } catch { finish(new Error("Invalid approval response.")); }
    });
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Human approval requires an interactive terminal. Piped or automated approval is not supported.");
  const [socketPath, approvalId, extra] = process.argv.slice(2);
  if (!socketPath || !approvalId || extra || !isAbsolute(socketPath)) throw new Error("Usage: npm run approve -- <absolute socketPath> <approvalId>");
  const [directory, socket] = await Promise.all([lstat(dirname(socketPath)), lstat(socketPath)]);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0 || !socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0) {
    throw new Error("Approval socket and directory must be private and owned by the current user.");
  }
  const pending = await command(socketPath, { op: "inspect", approvalId });
  if (pending.ok !== true) throw new Error(String(pending.error ?? "Approval unavailable."));
  console.log("Review this exact phone action. Text may be sensitive; it is not saved by TapPilot.");
  // JSON escaping makes terminal control characters visible instead of executable.
  console.log(JSON.stringify({ approvalId, method: pending.method, params: pending.params, observedTarget: pending.preview, expiresAt: pending.expiresAt }, null, 2));
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await readline.question('Type "approve" to authorize this one action: '); } finally { readline.close(); }
  if (answer !== "approve") { console.log("Not approved."); return; }
  const result = await command(socketPath, { op: "approve", approvalId, challenge: pending.challenge });
  if (result.ok !== true) throw new Error(String(result.error ?? "Approval failed."));
  console.log("Approved once. Ask Codex to retry the exact action before its expiry.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Approval failed.");
  process.exitCode = 1;
});
