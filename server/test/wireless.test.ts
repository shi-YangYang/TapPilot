import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import type { TLSSocket } from "node:tls";
import test from "node:test";
import WebSocket from "ws";
import { AgentError } from "../src/errors.js";
import { WirelessHub, listLANAddresses } from "../src/wireless.js";

type Json = Record<string, unknown>;
function pairing(hub: WirelessHub) {
  const uri = new URL(hub.pairingUri);
  return { endpoint: `wss://${uri.searchParams.get("host")}:${uri.searchParams.get("port")}/phone`, token: uri.searchParams.get("token")!, fingerprint: uri.searchParams.get("fingerprint")! };
}

function receive(socket: WebSocket, timeoutMs = 2000): Promise<Json> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off("message", message); socket.off("close", closed); socket.off("error", failed); };
    const message = (data: WebSocket.RawData) => { cleanup(); try { resolve(JSON.parse(data.toString()) as Json); } catch (error) { reject(error); } };
    const closed = () => { cleanup(); reject(new Error("synthetic peer closed")); };
    const failed = () => { cleanup(); reject(new Error("synthetic peer failed")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("synthetic peer timeout")); }, timeoutMs);
    socket.once("message", message);
    socket.once("close", closed);
    socket.once("error", failed);
  });
}

/** Synthetic phone trust model: trust a self-signed leaf ONLY after matching its out-of-band pin.
 * No application data or token is sent before this check. Production Android uses a pinned trust manager. */
async function pinnedSocket(hub: WirelessHub, fingerprint = pairing(hub).fingerprint): Promise<WebSocket> {
  const socket = new WebSocket(pairing(hub).endpoint, { rejectUnauthorized: false, perMessageDeflate: false });
  socket.on("error", () => {});
  await once(socket, "open");
  const tls = (socket as unknown as { _socket: TLSSocket })._socket;
  const leaf = new X509Certificate(tls.getPeerCertificate().raw);
  if (createHash("sha256").update(leaf.raw).digest("hex") !== fingerprint || Date.parse(leaf.validTo) <= Date.now() || Date.parse(leaf.validFrom) > Date.now()) {
    socket.terminate();
    throw new Error("synthetic certificate pin rejected");
  }
  assert.match(leaf.subject, /CN=TapPilot/);
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
  return socket;
}

async function phone(hub: WirelessHub, id = "synthetic-phone"): Promise<WebSocket> {
  const socket = await pinnedSocket(hub);
  const ready = receive(socket);
  socket.send(JSON.stringify({ type: "hello", version: 1, token: pairing(hub).token, deviceId: id, deviceName: "Synthetic Phone" }));
  assert.deepEqual(await ready, { type: "ready", version: 1 });
  return socket;
}

const reply = (socket: WebSocket, id: unknown, result: unknown = { synthetic: true }) => socket.send(JSON.stringify({ id, ok: true, result, meta: { durationMs: 2 } }));
const stopPhone = async (socket: WebSocket) => { const closed = once(socket, "close"); socket.terminate(); await closed; };

test("a pinned WSS phone pairs and serves strict RPC over one reusable connection", async () => {
  const states: unknown[] = [];
  const hub = await WirelessHub.start({ host: "127.0.0.1", onState: state => states.push(state) });
  try {
    assert.equal(hub.status().pairingAvailable, true);
    assert.equal(hub.status().connected, false);
    assert.equal(pairing(hub).token.length, 43);
    assert.equal(pairing(hub).fingerprint.length, 64);
    const socket = await phone(hub);
    assert.equal(hub.status().connected, true);
    assert.equal(hub.status().deviceId, "synthetic-phone");
    assert.equal(hub.status().pairingAvailable, false);
    assert.equal(JSON.stringify(states).includes(pairing(hub).token), false);
    socket.on("message", raw => { const request = JSON.parse(raw.toString()); assert.equal(request.method, "get_ui_tree"); reply(socket, request.id, { snapshotId: "synthetic-snapshot", nodes: [] }); });
    const bridge = hub.createBridge();
    for (let i = 0; i < 2; i++) {
      const result = await bridge.call("get_ui_tree", { maxNodes: 30 });
      assert.equal(result.ok, true);
      assert.equal(result.meta.durationMs, 2);
    }
    await bridge.close();
    assert.equal(hub.status().connected, true);
    await assert.rejects(bridge.call("get_ui_tree"), { code: "BRIDGE_CLOSED" });
    const next = hub.createBridge();
    assert.equal((await next.call("get_ui_tree")).ok, true);
    await next.close();
  } finally { await hub.close(); }
  assert.equal(hub.status().closed, true);
  assert.equal(hub.status().connected, false);
});

test("wrong certificate pin, token, hello version and injected fields cannot pair", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    await assert.rejects(pinnedSocket(hub, "0".repeat(64)), /pin rejected/);
    const unauthorized = new WebSocket(pairing(hub).endpoint); // Platform trust cannot silently accept this self-signed cert.
    unauthorized.on("error", () => {});
    await assert.rejects(once(unauthorized, "open"));
    for (const override of [{ token: "x".repeat(43) }, { version: 2 }, { unexpected: "injected" }, { deviceId: "invalid\nidentity" }]) {
      const socket = await pinnedSocket(hub);
      const closed = once(socket, "close");
      socket.send(JSON.stringify({ type: "hello", version: 1, token: pairing(hub).token, deviceId: "synthetic-phone", deviceName: "Synthetic", ...override }));
      await closed;
      assert.equal(hub.status().connected, false);
      assert.equal(hub.status().paired, false);
    }
    await phone(hub);
    assert.equal(hub.status().connected, true);
  } finally { await hub.close(); }
});

test("the upgrade endpoint rejects browser origins and token query strings", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    for (const [url, origin] of [[pairing(hub).endpoint, "https://untrusted.example"], [`${pairing(hub).endpoint}?token=not-accepted`, undefined]]) {
      const socket = new WebSocket(url!, { rejectUnauthorized: false, ...(origin ? { origin } : {}) });
      socket.on("error", () => {});
      await assert.rejects(once(socket, "open"), /403/);
    }
    assert.equal(hub.status().paired, false);
  } finally { await hub.close(); }
});

test("one device remains pinned across reconnects and a second connection cannot replace it", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    const first = await phone(hub);
    await assert.rejects(pinnedSocket(hub), /403/);
    assert.equal(hub.status().connected, true);
    await stopPhone(first);
    // Wait for the host's close handler, without polling or a fixed sleep.
    if (hub.status().connected) await new Promise<void>(resolve => setImmediate(resolve));
    const other = await pinnedSocket(hub);
    const rejected = once(other, "close");
    other.send(JSON.stringify({ type: "hello", version: 1, token: pairing(hub).token, deviceId: "different-device", deviceName: "Synthetic" }));
    await rejected;
    assert.equal(hub.status().deviceId, "synthetic-phone");
    await phone(hub);
    assert.equal(hub.status().connected, true);
  } finally { await hub.close(); }
});

test("unpaired credentials expire after five minutes", async t => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    t.mock.timers.tick(5 * 60_000 + 1);
    const socket = await pinnedSocket(hub);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hello", version: 1, token: pairing(hub).token, deviceId: "synthetic-phone", deviceName: "Synthetic" }));
    await closed;
    assert.equal(hub.status().pairingAvailable, false);
    assert.equal(hub.status().paired, false);
  } finally { t.mock.timers.reset(); await hub.close(); }
});

test("closing one bridge rejects only its requests and known late responses do not poison the shared session", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    const socket = await phone(hub);
    const first = hub.createBridge();
    const second = hub.createBridge();
    const pendingRequest = receive(socket);
    const pending = first.call("input_text", { text: "synthetic text" });
    const rejection = assert.rejects(pending, { code: "BRIDGE_CLOSED" });
    const request = await pendingRequest;
    await first.close();
    await rejection;
    reply(socket, request.id);
    const nextRequest = receive(socket);
    const next = second.call("get_current_app");
    reply(socket, (await nextRequest).id, { packageName: "synthetic.app" });
    assert.equal((await next).ok, true);
    assert.equal(hub.status().connected, true);
    await second.close();
  } finally { await hub.close(); }
});

test("timeout and disconnection do not replay a mutation, and emergency stop can run independently", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    const socket = await phone(hub);
    const bridge = hub.createBridge();
    let actions = 0;
    socket.on("message", raw => { const request = JSON.parse(raw.toString()); if (request.method === "input_text") actions++; else if (request.method === "emergency_stop") reply(socket, request.id, { stopped: true }); });
    const pending = bridge.call("input_text", { text: "synthetic" }, 35);
    const timedOut = assert.rejects(pending, { code: "WIRELESS_TIMEOUT" });
    assert.equal((await bridge.call("emergency_stop")).ok, true);
    await timedOut;
    assert.equal(actions, 1);
    const received = receive(socket);
    const disconnected = bridge.call("input_text", { text: "synthetic" });
    const failed = assert.rejects(disconnected, { code: "WIRELESS_DISCONNECTED" });
    await received;
    await stopPhone(socket);
    await failed;
    const replacement = await phone(hub);
    let unsolicited = 0;
    replacement.on("message", raw => { const request = JSON.parse(raw.toString()); if (request.method === "input_text") unsolicited++; else reply(replacement, request.id); });
    await assert.rejects(bridge.call("get_ui_tree"), { code: "WIRELESS_SESSION_CHANGED" });
    await hub.createBridge().call("get_ui_tree");
    assert.equal(unsolicited, 0);
    assert.equal(actions, 2);
  } finally { await hub.close(); }
});

test("invalid response IDs, Schema and binary frames fail closed", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    for (const variant of ["id", "schema", "binary"] as const) {
      const socket = await phone(hub);
      const bridge = hub.createBridge();
      const next = receive(socket);
      const request = bridge.call("get_ui_tree");
      const rejected = assert.rejects(request, { code: "WIRELESS_PROTOCOL_ERROR" });
      const frame = await next;
      if (variant === "id") reply(socket, "unknown-id");
      else if (variant === "schema") socket.send(JSON.stringify({ id: frame.id, ok: true, result: {}, error: { code: "ERROR", message: "bad", retryable: false }, meta: { durationMs: 1 } }));
      else socket.send(Buffer.from("{}"));
      await rejected;
      await bridge.close();
      assert.equal(hub.status().connected, false);
    }
  } finally { await hub.close(); }
});

test("final dispatch gates and bounds prevent writes after cancellation", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    const socket = await phone(hub);
    const bridge = hub.createBridge();
    let frames = 0;
    socket.on("message", () => frames++);
    await assert.rejects(bridge.call("input_text", {}, 100, () => { throw new AgentError("EMERGENCY_STOPPED", "synthetic stop"); }), { code: "EMERGENCY_STOPPED" });
    await assert.rejects(bridge.call("input_text", { text: "x".repeat(256 * 1024) }), { code: "REQUEST_TOO_LARGE" });
    await assert.rejects(bridge.call("get_ui_tree", {}, 0), { code: "INVALID_ARGUMENT" });
    await assert.rejects(bridge.call("input_text", {}, 100, () => { void bridge.close(); }), { code: "BRIDGE_CLOSED" });
    assert.equal(frames, 0);
  } finally { await hub.close(); }
});

test("wireless only binds a selected local interface and close invalidates the session", async () => {
  assert.ok(listLANAddresses().every(entry => entry.address !== "0.0.0.0" && entry.name.length > 0));
  for (const host of ["0.0.0.0", "8.8.8.8", "::", "127.0.0.2"]) await assert.rejects(WirelessHub.start({ host }), { code: "WIRELESS_INVALID_INTERFACE" });
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  const bridge = hub.createBridge();
  await hub.close();
  await hub.close();
  await assert.rejects(bridge.call("get_ui_tree"), { code: "BRIDGE_CLOSED" });
  assert.equal(hub.status().pairingAvailable, false);
});

test("wireless bounds frames and pending work while reserving an emergency stop slot", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  try {
    const socket = await phone(hub);
    const bridge = hub.createBridge();
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      if (request.method === "emergency_stop") reply(socket, request.id, { stopped: true });
    });
    const outstanding = Array.from({ length: 8 }, () => assert.rejects(bridge.call("wait_for_ui_change"), { code: "BRIDGE_CLOSED" }));
    await assert.rejects(bridge.call("get_ui_tree"), { code: "WIRELESS_BUSY" });
    assert.equal((await bridge.call("emergency_stop")).ok, true);
    await bridge.close();
    await Promise.all(outstanding);
    const next = hub.createBridge();
    const request = receive(socket);
    const failed = assert.rejects(next.call("get_ui_tree"), { code: "WIRELESS_DISCONNECTED" });
    await request;
    socket.send("x".repeat(4 * 1024 * 1024 + 1));
    await failed;
    assert.equal(hub.status().connected, false);
  } finally { await hub.close(); }
});
