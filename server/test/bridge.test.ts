import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { Bridge, requestJson, staleSnapshotReasons } from "../src/bridge.js";
import { Adb } from "../src/adb.js";
import { AgentError } from "../src/errors.js";

async function fixture(handle: (socket: Socket, request: Record<string, unknown>) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) handle(socket, JSON.parse(data)); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as { port: number }).port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("NDJSON bridge handles fragmented UTF-8, correlated IDs and explicit Android errors", async () => {
  const f = await fixture((socket, req) => {
    assert.equal(req.method, "get_ui_tree");
    const frame = Buffer.from(JSON.stringify({ id: req.id, ok: true, result: { text: "电池" }, meta: { durationMs: 2 } }) + "\n");
    const index = frame.indexOf(Buffer.from("电")) + 1;
    socket.write(frame.subarray(0, index));
    setImmediate(() => socket.end(frame.subarray(index)));
  });
  try { assert.deepEqual((await requestJson(f.port, "get_ui_tree", {}, 1000)).result, { text: "电池" }); }
  finally { await f.close(); }
});

test("NDJSON preserves fixed stale reasons and legacy errors without arbitrary diagnostics", async () => {
  const errors = [
    ...staleSnapshotReasons.map(reason => ({ code: "STALE_SNAPSHOT", message: "Synthetic stale", retryable: true, details: { reason } })),
    { code: "STALE_SNAPSHOT", message: "Synthetic legacy stale", retryable: true },
  ];
  for (const error of errors) {
    const f = await fixture((socket, req) => socket.end(JSON.stringify({ id: req.id, ok: false, error, meta: { durationMs: 0 } }) + "\n"));
    try { assert.deepEqual((await requestJson(f.port, "get_ui_tree", {}, 1000)).error, error); }
    finally { await f.close(); }
  }
  for (const error of [
    { code: "STALE_SNAPSHOT", details: { reason: "Synthetic private text" } },
    { code: "STALE_SNAPSHOT", details: { reason: "NODE_CONTENT_CHANGED", label: "Synthetic private text" } },
    { code: "STALE_SNAPSHOT", details: { reason: { text: "Synthetic private text" } } },
    { code: "ACTION_REJECTED", details: { reason: "NODE_CONTENT_CHANGED" } },
  ]) {
    const f = await fixture((socket, req) => socket.end(JSON.stringify({ id: req.id, ok: false, error: { message: "Synthetic refusal", retryable: true, ...error }, meta: { durationMs: 0 } }) + "\n"));
    try { await assert.rejects(requestJson(f.port, "get_ui_tree", {}, 1000), { code: "BRIDGE_PROTOCOL_ERROR" }); }
    finally { await f.close(); }
  }
});

test("NDJSON rejects wrong IDs, invalid schemas and oversized responses", async (t) => {
  for (const kind of ["id", "schema", "size"]) await t.test(kind, async () => {
    const f = await fixture((socket, req) => {
      if (kind === "size") socket.end("x".repeat(4 * 1024 * 1024 + 1));
      else socket.end(JSON.stringify({ id: kind === "id" ? "wrong-id" : req.id, ok: true, result: {}, meta: { durationMs: kind === "schema" ? -1 : 0 } }) + "\n");
    });
    try { await assert.rejects(requestJson(f.port, "get_current_app", {}, 2000), { code: kind === "size" ? "RESPONSE_TOO_LARGE" : "BRIDGE_PROTOCOL_ERROR" }); }
    finally { await f.close(); }
  });
});

test("timeouts and premature disconnects never retry a mutation", async (t) => {
  for (const close of [false, true]) await t.test(close ? "disconnect" : "timeout", async () => {
    let requests = 0;
    const f = await fixture((socket) => { requests++; if (close) socket.end(); });
    try {
      await assert.rejects(requestJson(f.port, "click_element", { snapshotId: "s", nodeId: "n1" }, 30), { code: close ? "BRIDGE_CLOSED" : "BRIDGE_TIMEOUT", retryable: false });
      assert.equal(requests, 1);
    } finally { await f.close(); }
  });
});

test("emergency gate prevents dispatch after delayed ADB setup and immediately before socket write", async () => {
  let requests = 0;
  const f = await fixture(() => { requests++; });
  let release!: (port: number) => void;
  class DelayedAdb extends Adb {
    override ensureForward(): Promise<number> { return new Promise((resolve) => { release = resolve; }); }
    override async close(): Promise<void> {}
  }
  const bridge = new Bridge(new DelayedAdb());
  let stopped = false;
  const guard = () => { if (stopped) throw new AgentError("EMERGENCY_STOPPED", "Stopped."); };
  try {
    const pending = bridge.call("scroll", {}, 1000, guard);
    stopped = true;
    release(f.port);
    await assert.rejects(pending, { code: "EMERGENCY_STOPPED" });
    assert.equal(requests, 0);
    await assert.rejects(requestJson(f.port, "scroll", {}, 1000, undefined, guard), { code: "EMERGENCY_STOPPED" });
    assert.equal(requests, 0);
  } finally { await bridge.close(); await f.close(); }
});

test("USB preserves native not-sent evidence and observation only in the strict refusal envelope", async () => {
  const error = { code: "TARGET_CHANGED", message: "Synthetic target changed", retryable: true,
    details: { executor: "node-v1", dispatchState: "not_sent", reason: "PAGE_CONTEXT_CHANGED" } };
  const observation = { executor: "node-v1", snapshotId: "synthetic:2", nodes: [] };
  const f = await fixture((socket, request) => socket.end(JSON.stringify({ id: request.id, ok: false, error, observation, meta: { durationMs: 1 } }) + "\n"));
  try {
    const response = await requestJson(f.port, "act_and_observe", {}, 1000);
    assert.deepEqual(response.error, error);
    assert.deepEqual(response.observation, observation);
  } finally { await f.close(); }
  for (const unsafe of [
    { ...error, details: { ...error.details, reason: "private text" } },
    { ...error, details: { ...error.details, dispatchState: "sent" } },
    { ...error, details: { ...error.details, rawLabel: "private text" } },
    { ...error, code: "BRIDGE_TIMEOUT" },
    { ...error, details: undefined },
  ]) {
    const bad = await fixture((socket, request) => socket.end(JSON.stringify({ id: request.id, ok: false, error: unsafe, observation, meta: { durationMs: 1 } }) + "\n"));
    try { await assert.rejects(requestJson(bad.port, "act_and_observe", {}, 1000), { code: "BRIDGE_PROTOCOL_ERROR" }); }
    finally { await bad.close(); }
  }
});
