import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { isIPv4 } from "node:net";
import type { Duplex } from "node:stream";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { phoneErrorSchema, type BridgeResponse, type PhoneBridge } from "./bridge.js";
import { AgentError, publicError } from "./errors.js";

const exec = promisify(execFile);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const PAIRING_LIFETIME_MS = 5 * 60_000;
const helloSchema = z.object({
  type: z.literal("hello"), version: z.literal(1),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  deviceName: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]*$/),
}).strict();
const responseSchema = z.object({
  id: z.string().min(1).max(128), ok: z.boolean(), result: z.unknown().optional(),
  error: phoneErrorSchema.optional(),
  meta: z.object({ durationMs: z.number().finite().nonnegative() }).strict(),
}).strict().refine(value => value.ok ? !value.error && "result" in value : !!value.error && !("result" in value));

export type LANAddress = { address: string; name: string };
export type WirelessState = {
  connected: boolean; paired: boolean; closed: boolean; host: string; port: number;
  pairingExpiresAt: number; pairingAvailable: boolean; deviceId?: string; deviceName?: string;
};
export type WirelessOptions = { host?: string; port?: number; onState?: (state: WirelessState) => void };

function privateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168);
}

/** Only concrete local RFC1918 addresses are offered; never bind all interfaces or a public IP. */
export function listLANAddresses(): LANAddress[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter(entry => !entry.internal && entry.family === "IPv4" && privateIPv4(entry.address))
    .map(entry => ({ address: entry.address, name }))).sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

async function ephemeralCertificate(host: string): Promise<{ key: Buffer; cert: Buffer; fingerprint: string }> {
  // mkdtemp creates a private directory. No generated key or pairing secret enters the repository.
  const directory = await mkdtemp(join(tmpdir(), "tappilot-tls-"));
  try {
    const config = join(directory, "openssl.cnf");
    const keyFile = join(directory, "key.pem");
    const certFile = join(directory, "cert.pem");
    await writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=server\n[dn]\n[server]\nsubjectAltName=IP:${host},DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=TapPilot", "-config", config, "-keyout", keyFile, "-out", certFile], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
    const fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
    return { key, cert, fingerprint };
  } catch {
    throw new AgentError("WIRELESS_TLS_SETUP_FAILED", "无法生成无线会话证书，请确认系统 /usr/bin/openssl 可用。");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

type Pending = {
  owner: symbol; socket: WebSocket; timer: ReturnType<typeof setTimeout>;
  resolve: (value: BridgeResponse) => void; reject: (error: AgentError) => void;
};

/** A user-started, ephemeral LAN session. The phone initiates a certificate-pinned WSS connection.
 * Pairing credentials remain host UI state; never include pairingUri in a model tool response. */
export class WirelessHub {
  readonly pairingUri: string;
  private readonly token: Buffer;
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  private readonly wss: WebSocketServer;
  private readonly pending = new Map<string, Pending>();
  private readonly retired = new Map<string, number>();
  private readonly handshakeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly pairingTimer: ReturnType<typeof setTimeout>;
  private active?: WebSocket;
  private generation = 0;
  private alive = false;
  private deviceId?: string;
  private deviceName?: string;
  private closed = false;
  private closePromise?: Promise<void>;
  private port = 0;
  private readonly pairingExpiresAt = Date.now() + PAIRING_LIFETIME_MS;

  private constructor(private readonly host: string, credentials: { key: Buffer; cert: Buffer; fingerprint: string }, private readonly onState?: WirelessOptions["onState"]) {
    const token = randomBytes(32).toString("base64url");
    this.token = Buffer.from(token, "ascii");
    const uri = new URL("tappilot://pair");
    uri.search = new URLSearchParams({ host, port: "0", fingerprint: credentials.fingerprint, token }).toString();
    this.pairingUri = uri.toString();
    this.server = createServer({ key: credentials.key, cert: credentials.cert, minVersion: "TLSv1.2", handshakeTimeout: 5_000, maxHeaderSize: 8192 }, (_req, res) => { res.writeHead(404, { "Cache-Control": "no-store" }).end(); });
    this.server.maxConnections = 12;
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 5_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.on("connection", socket => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.on("tlsClientError", () => { /* Deliberately do not log peer input or certificate details. */ });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: true });
    this.wss.on("error", () => { this.disconnectActive(new AgentError("WIRELESS_SERVER_ERROR", "无线连接发生错误，已停止；不会重放动作。")); });
    this.server.on("upgrade", (request, socket, head) => {
      if (this.closed || request.method !== "GET" || request.url !== "/phone" || request.headers.origin !== undefined || this.handshakeTimers.size >= 4 || this.active?.readyState === WebSocket.OPEN) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(request, socket, head, ws => this.accept(ws));
    });
    this.heartbeat = setInterval(() => {
      if (!this.active) return;
      if (!this.alive) { this.disconnectActive(new AgentError("WIRELESS_DISCONNECTED", "手机无线连接已中断，动作结果可能未知；不会自动重试。")); return; }
      this.alive = false;
      this.active.ping();
    }, 15_000);
    this.heartbeat.unref();
    this.pairingTimer = setTimeout(() => this.notify(), PAIRING_LIFETIME_MS);
    this.pairingTimer.unref();
  }

  static async start(options: WirelessOptions = {}): Promise<WirelessHub> {
    const addresses = listLANAddresses();
    const host = options.host ?? addresses[0]?.address;
    if (!host || (host !== "127.0.0.1" && !addresses.some(entry => entry.address === host))) {
      throw new AgentError("WIRELESS_INVALID_INTERFACE", "请选择本机的局域网 IPv4 地址；不能监听所有网卡或公网地址。");
    }
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AgentError("WIRELESS_INVALID_PORT", "无线监听端口无效。");
    const credentials = await ephemeralCertificate(host);
    const hub = new WirelessHub(host, credentials, options.onState);
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new AgentError("WIRELESS_LISTEN_FAILED", "无法在所选局域网地址启动无线连接，请检查网卡和端口。"));
        hub.server.once("error", fail);
        hub.server.listen(port, host, () => { hub.server.removeListener("error", fail); resolve(); });
      });
      hub.server.on("error", () => { hub.disconnectActive(new AgentError("WIRELESS_SERVER_ERROR", "无线监听发生错误；已停止当前操作。")); });
      const address = hub.server.address();
      if (!address || typeof address === "string") throw new AgentError("WIRELESS_LISTEN_FAILED", "无线监听没有有效端口。");
      hub.port = address.port;
      const uri = new URL(hub.pairingUri);
      uri.searchParams.set("port", String(hub.port));
      // Assigned once after the OS has selected an ephemeral port.
      Object.defineProperty(hub, "pairingUri", { value: uri.toString(), writable: false, enumerable: false });
      hub.notify();
      return hub;
    } catch (error) { await hub.close(); throw publicError(error); }
    finally { credentials.key.fill(0); }
  }

  status(): WirelessState {
    return {
      connected: !this.closed && this.active?.readyState === WebSocket.OPEN, paired: this.deviceId !== undefined,
      closed: this.closed, host: this.host, port: this.port, pairingExpiresAt: this.pairingExpiresAt,
      pairingAvailable: !this.closed && !this.deviceId && Date.now() < this.pairingExpiresAt,
      ...(this.deviceId ? { deviceId: this.deviceId, deviceName: this.deviceName } : {}),
    };
  }

  private notify(): void { try { this.onState?.(this.status()); } catch { /* UI callbacks cannot change the transport. */ } }

  private accept(socket: WebSocket): void {
    const timer = setTimeout(() => this.rejectSocket(socket), 5_000);
    timer.unref();
    this.handshakeTimers.set(socket, timer);
    socket.on("error", () => { if (this.active === socket) this.disconnectActive(new AgentError("WIRELESS_DISCONNECTED", "无线连接失败，动作结果可能未知；不会自动重试。")); else this.rejectSocket(socket); });
    socket.on("close", () => {
      this.clearHandshake(socket);
      if (this.active === socket) this.disconnectActive(new AgentError("WIRELESS_DISCONNECTED", "手机无线连接已关闭，动作结果可能未知；不会自动重试。"));
    });
    socket.on("pong", () => { if (this.active === socket) this.alive = true; });
    socket.on("message", (raw, binary) => this.message(socket, raw, binary));
  }

  private clearHandshake(socket: WebSocket): void {
    const timer = this.handshakeTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.handshakeTimers.delete(socket);
  }

  private rejectSocket(socket: WebSocket): void {
    this.clearHandshake(socket);
    socket.terminate();
  }

  private message(socket: WebSocket, raw: RawData, binary: boolean): void {
    if (this.closed) return this.rejectSocket(socket);
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (binary || data.length > MAX_FRAME_BYTES) return this.protocolFailure(socket);
    let value: unknown;
    try { value = JSON.parse(data.toString("utf8")); }
    catch { return this.protocolFailure(socket); }
    if (this.active !== socket) {
      if (!this.handshakeTimers.has(socket) || data.length > 4096) return this.rejectSocket(socket);
      const hello = helloSchema.safeParse(value);
      if (!hello.success) return this.rejectSocket(socket);
      const presented = Buffer.from(hello.data.token, "ascii");
      const authorized = presented.length === this.token.length && timingSafeEqual(presented, this.token);
      if (!authorized || this.active || (!this.deviceId && Date.now() >= this.pairingExpiresAt) || (this.deviceId && this.deviceId !== hello.data.deviceId)) return this.rejectSocket(socket);
      this.clearHandshake(socket);
      this.deviceId = hello.data.deviceId;
      this.deviceName = hello.data.deviceName;
      this.active = socket;
      this.generation++;
      this.alive = true;
      socket.send(JSON.stringify({ type: "ready", version: 1 }), error => { if (error && this.active === socket) this.disconnectActive(new AgentError("WIRELESS_DISCONNECTED", "无线握手失败；没有派发操作。")); });
      this.notify();
      return;
    }
    const response = responseSchema.safeParse(value);
    if (!response.success) return this.protocolFailure(socket);
    const pending = this.pending.get(response.data.id);
    if (!pending) {
      // Cancellation and timeouts do not cancel a phone action already in flight. Discard only those
      // known late replies; an arbitrary ID or duplicated completed reply terminates the session.
      const expiry = this.retired.get(response.data.id);
      if (expiry && expiry >= Date.now()) { this.retired.delete(response.data.id); return; }
      return this.protocolFailure(socket);
    }
    if (pending.socket !== socket) return this.protocolFailure(socket);
    this.pending.delete(response.data.id);
    clearTimeout(pending.timer);
    pending.resolve(response.data);
  }

  private protocolFailure(socket: WebSocket): void {
    if (this.active === socket) this.disconnectActive(new AgentError("WIRELESS_PROTOCOL_ERROR", "手机返回了无效帧、Schema 或请求 ID。已断开连接；不会重放操作。"));
    else this.rejectSocket(socket);
  }

  private disconnectActive(error: AgentError): void {
    const socket = this.active;
    if (!socket) return;
    this.active = undefined;
    this.alive = false;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.retired.clear();
    socket.terminate();
    this.notify();
  }

  private retire(id: string): void {
    for (const [retiredId, expiry] of this.retired) if (expiry < Date.now()) this.retired.delete(retiredId);
    if (this.retired.size >= 256) this.retired.delete(this.retired.keys().next().value!);
    this.retired.set(id, Date.now() + 60_000);
  }

  createBridge(): PhoneBridge {
    const owner = Symbol("wireless-task");
    const connection = this.active;
    const generation = this.generation;
    let closed = false;
    return {
      call: async (method, params = {}, timeoutMs = 10_000, beforeDispatch) => {
        if (closed || this.closed) throw new AgentError("BRIDGE_CLOSED", "此无线任务连接已关闭。");
        if (generation !== this.generation || (connection && this.active !== connection)) throw new AgentError("WIRELESS_SESSION_CHANGED", "手机连接已变化，此任务已失效。请确认当前界面后重新开始任务。");
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(method) || !params || typeof params !== "object" || Array.isArray(params) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
          throw new AgentError("INVALID_ARGUMENT", "无线请求方法、参数或超时无效。");
        }
        const socket = this.active;
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new AgentError("WIRELESS_DISCONNECTED", "手机未连接。请在同一局域网配对并连接后再开始任务。");
        // Reserve one independent request slot for emergency stop. No queued or timed-out action is replayed.
        if (this.pending.size >= (method === "emergency_stop" ? 9 : 8) || socket.bufferedAmount > MAX_FRAME_BYTES) throw new AgentError("WIRELESS_BUSY", "无线请求过多，未派发此操作。");
        const id = randomUUID();
        let request: string;
        try { request = JSON.stringify({ id, method, params }); }
        catch { throw new AgentError("INVALID_ARGUMENT", "无线请求参数无法序列化。"); }
        if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) throw new AgentError("REQUEST_TOO_LARGE", "无线请求超出大小限制，未派发。");
        return new Promise<BridgeResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!this.pending.delete(id)) return;
            this.retire(id);
            reject(new AgentError("WIRELESS_TIMEOUT", "手机无线请求超时，动作可能已经发生。请先读取当前界面；不会自动重试。"));
          }, timeoutMs);
          this.pending.set(id, { owner, socket, timer, resolve, reject });
          try {
            // The stop guard and send share a single synchronous event-loop turn.
            beforeDispatch?.();
            if (closed || this.closed || this.active !== socket || socket.readyState !== WebSocket.OPEN) throw new AgentError("BRIDGE_CLOSED", "请求派发前连接或任务已关闭，未执行操作。");
            socket.send(request, error => { if (error && this.active === socket) this.disconnectActive(new AgentError("WIRELESS_DISCONNECTED", "无线发送失败，动作结果可能未知；不会自动重试。")); });
          } catch (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(publicError(error));
          }
        });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        for (const [id, pending] of this.pending) if (pending.owner === owner) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          this.retire(id);
          pending.reject(new AgentError("BRIDGE_CLOSED", "任务已取消；已派发的动作可能已经完成，不会重放。"));
        }
      },
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.pairingTimer);
    this.disconnectActive(new AgentError("WIRELESS_CLOSED", "无线会话已关闭；已派发动作的结果可能未知。"));
    for (const socket of this.handshakeTimers.keys()) this.rejectSocket(socket);
    this.token.fill(0);
    this.closePromise = Promise.all([
      new Promise<void>(resolve => this.wss.close(() => resolve())),
      new Promise<void>(resolve => this.server.close(() => resolve())),
    ]).then(() => { this.notify(); });
    for (const socket of this.sockets) socket.destroy();
    return this.closePromise;
  }
}
