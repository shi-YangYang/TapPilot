import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { z } from "zod";
import { Adb } from "./adb.js";
import { AgentError, publicError } from "./errors.js";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
// Fixed diagnostics only: never transport node labels, fingerprints or arbitrary details.
export const staleSnapshotReasons = [
  "SNAPSHOT_MISSING", "WINDOW_CHANGED", "TREE_INCOMPLETE", "TREE_STRUCTURE_CHANGED",
  "NODE_CONTENT_CHANGED", "NODE_BOUNDS_CHANGED", "NODE_STATE_CHANGED", "NODE_UNAVAILABLE",
] as const;
export const phoneErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), message: z.string().max(2048), retryable: z.boolean(),
  details: z.object({ reason: z.enum(staleSnapshotReasons) }).strict().optional(),
}).strict().refine(error => error.details === undefined || error.code === "STALE_SNAPSHOT");
const envelopeSchema = z.object({
  id: z.string().min(1).max(128), ok: z.boolean(), result: z.unknown().optional(),
  error: phoneErrorSchema.optional(),
  meta: z.object({ durationMs: z.number().finite().nonnegative() }),
}).strict().refine((v) => v.ok ? !v.error && "result" in v : !!v.error && !("result" in v));

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: z.infer<typeof phoneErrorSchema>;
  meta: { durationMs: number };
}

/** One bounded NDJSON request/response per connection; mutations are never retried. */
export function requestJson(port: number, method: string, params: Record<string, unknown>, timeoutMs: number,
  register?: (socket: Socket) => () => void, beforeDispatch?: () => void): Promise<BridgeResponse> {
  const id = randomUUID();
  const request = JSON.stringify({ id, method, params }) + "\n";
  if (Buffer.byteLength(request) > MAX_FRAME_BYTES) throw new AgentError("REQUEST_TOO_LARGE", "Bridge request exceeds the size limit.");
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const unregister = register?.(socket);
    let done = false;
    let buffer = Buffer.alloc(0);
    const finish = (error?: AgentError, result?: BridgeResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unregister?.();
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new AgentError("BRIDGE_TIMEOUT", "Bridge timed out; the action may already have happened. Read the UI before deciding what to do next.", false)), timeoutMs);
    socket.on("connect", () => {
      // The final stop gate and write share one synchronous event-loop turn.
      try { beforeDispatch?.(); socket.write(request); } catch (error) { finish(publicError(error)); }
    });
    socket.on("error", () => finish(new AgentError("BRIDGE_UNAVAILABLE", "Cannot reach the phone service. Enable TapPilot AccessibilityService and verify the USB connection.", true)));
    socket.on("close", () => { if (!done) finish(new AgentError("BRIDGE_CLOSED", "Bridge closed without a response. Read the UI before retrying an action.", false)); });
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_FRAME_BYTES) return finish(new AgentError("RESPONSE_TOO_LARGE", "Bridge response exceeds the size limit."));
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      try {
        if (buffer.subarray(newline + 1).toString("utf8").trim()) throw new Error("extra frame");
        const parsed = envelopeSchema.safeParse(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
        if (!parsed.success || parsed.data.id !== id) throw new Error("invalid envelope");
        finish(undefined, parsed.data);
      } catch { finish(new AgentError("BRIDGE_PROTOCOL_ERROR", "Bridge returned an invalid frame, schema, or request ID.")); }
    });
  });
}

export interface PhoneBridge {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number, beforeDispatch?: () => void): Promise<BridgeResponse>;
  close(): Promise<void>;
}

export class Bridge implements PhoneBridge {
  private readonly sockets = new Set<Socket>();
  private closed = false;
  constructor(readonly adb: Adb) {}

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000, beforeDispatch?: () => void): Promise<BridgeResponse> {
    if (this.closed) throw new AgentError("SHUTTING_DOWN", "MCP server is shutting down.");
    const port = await this.adb.ensureForward();
    if (this.closed) throw new AgentError("SHUTTING_DOWN", "MCP server is shutting down.");
    beforeDispatch?.();
    return requestJson(port, method, params, timeoutMs, (socket) => {
      this.sockets.add(socket);
      return () => this.sockets.delete(socket);
    }, beforeDispatch);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await this.adb.close();
  }
}
