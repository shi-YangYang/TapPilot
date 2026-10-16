import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "./errors.js";

const TTL_MS = 120_000;
const MAX_PENDING = 64;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function actionHash(method: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(canonical({ method, params })).digest("hex");
}

interface Pending {
  id: string;
  hash: string;
  method: string;
  params: Record<string, unknown>;
  preview: Record<string, unknown>;
  expiresAt: number;
  approved: boolean;
  challenge?: string;
}

export interface ApprovalPrompt {
  approvalId: string;
  socketPath: string;
  expiresAt: string;
  description: string;
  instruction: string;
}

/** No MCP approval endpoint: only the separate human-facing local CLI can approve. */
export class ApprovalQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  private directory?: string;
  private socketPath?: string;
  private timer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private closed = false;
  constructor(private readonly now: () => number = Date.now) {}

  private expire(): void {
    const now = this.now();
    for (const [id, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(id);
  }

  async start(): Promise<void> {
    if (this.closed) throw new AgentError("SHUTTING_DOWN", "Approval queue is closed.");
    if (this.starting) return this.starting;
    if (this.server) return;
    this.starting = this.listen();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async listen(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "tappilot-"));
    this.directory = directory;
    await chmod(directory, 0o700);
    const socketPath = join(directory, "approve.sock");
    if (Buffer.byteLength(socketPath) > 103) {
      await rm(directory, { recursive: true, force: true });
      throw new AgentError("APPROVAL_SOCKET_PATH_TOO_LONG", "TMPDIR path is too long for a Unix socket. Use a shorter private temporary directory.");
    }
    this.socketPath = socketPath;
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => { this.server!.removeListener("error", reject); resolve(); });
    });
    this.server.on("error", () => this.clear());
    await chmod(socketPath, 0o600);
    this.timer = setInterval(() => this.expire(), 10_000);
    this.timer.unref();
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
    let data = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (handled) return;
      data += chunk;
      if (Buffer.byteLength(data) > 4096) { socket.destroy(); return; }
      if (!data.includes("\n")) return;
      handled = true;
      let response: Record<string, unknown>;
      try { response = this.handleCommand(JSON.parse(data)); }
      catch { response = { ok: false, error: "Invalid approval command." }; }
      socket.end(JSON.stringify(response) + "\n");
    });
  }

  private handleCommand(value: unknown): Record<string, unknown> {
    this.expire();
    if (!value || typeof value !== "object") return { ok: false, error: "Invalid command." };
    const command = value as Record<string, unknown>;
    const item = typeof command.approvalId === "string" ? this.pending.get(command.approvalId) : undefined;
    if (!item) return { ok: false, error: "Approval expired, consumed, cancelled, or unknown." };
    if (command.op === "inspect") {
      if (item.approved) return { ok: false, error: "This action has already been approved." };
      item.challenge = randomBytes(24).toString("hex");
      return { ok: true, approvalId: item.id, method: item.method, params: item.params, preview: item.preview,
        expiresAt: new Date(item.expiresAt).toISOString(), challenge: item.challenge };
    }
    if (command.op === "approve" && !item.approved && item.challenge && typeof command.challenge === "string") {
      const expected = Buffer.from(item.challenge);
      const actual = Buffer.from(command.challenge);
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        item.approved = true;
        item.challenge = undefined;
        return { ok: true, approved: true };
      }
    }
    return { ok: false, error: "Invalid or already used confirmation challenge." };
  }

  /** Returns a prompt or atomically consumes exactly one matching approval. */
  async require(method: string, params: Record<string, unknown>, preview: Record<string, unknown>): Promise<ApprovalPrompt | undefined> {
    await this.start();
    this.expire();
    const hash = actionHash(method, params);
    let item = [...this.pending.values()].find((entry) => entry.hash === hash);
    if (item?.approved) { this.pending.delete(item.id); return undefined; }
    if (!item) {
      if (this.pending.size >= MAX_PENDING) throw new AgentError("APPROVAL_QUEUE_FULL", "Too many pending actions. Wait for expiry or use emergency_stop.");
      item = { id: randomUUID(), hash, method, params: structuredClone(params), preview: structuredClone(preview), expiresAt: this.now() + TTL_MS, approved: false };
      this.pending.set(item.id, item);
    }
    return {
      approvalId: item.id, socketPath: this.socketPath!, expiresAt: new Date(item.expiresAt).toISOString(),
      description: `Human approval required for ${method}. Exact action arguments are shown only in the local terminal.`,
      instruction: "Ask the human to run npm run approve -- <socketPath> <approvalId> from server/. Do not run the CLI or access its socket yourself. After human approval, repeat the exact same tool arguments before expiry. Do not repeatedly poll or alter arguments.",
    };
  }

  clear(): void { this.pending.clear(); }

  async close(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    this.clear();
    if (this.timer) clearInterval(this.timer);
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
