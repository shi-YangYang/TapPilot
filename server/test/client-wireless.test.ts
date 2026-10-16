import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { TLSSocket } from "node:tls";
import test from "node:test";
import WebSocket from "ws";
import { createWirelessClient } from "../src/client-tools.js";
import { WirelessHub } from "../src/wireless.js";
import { snapshot } from "./helpers.js";

test("wireless client runs observe/action/observe without ADB and reuses the paired phone across tasks", async () => {
  const hub = await WirelessHub.start({ host: "127.0.0.1" });
  const pairing = new URL(hub.pairingUri);
  // Test-only synthetic phone verifies the pinned leaf before sending any credential or UI.
  const phone = new WebSocket(`wss://127.0.0.1:${hub.status().port}/phone`, { rejectUnauthorized: false });
  const received: string[] = [];
  let client: ReturnType<typeof createWirelessClient> | undefined;
  try {
    await once(phone, "open");
    const socket = (phone as unknown as { _socket: TLSSocket })._socket;
    assert.equal(createHash("sha256").update(socket.getPeerCertificate().raw).digest("hex"), pairing.searchParams.get("fingerprint"));
    const ready = once(phone, "message");
    phone.send(JSON.stringify({ type: "hello", version: 1, token: pairing.searchParams.get("token"), deviceId: "synthetic-phone", deviceName: "Fixture Android" }));
    assert.equal(JSON.parse(String((await ready)[0])).type, "ready");
    phone.on("message", data => {
      const request = JSON.parse(String(data));
      received.push(request.method);
      const result = request.method === "get_device_info" ? { serviceConnected: true, stopped: false }
        : request.method === "act_and_observe" ? { action: { accepted: true, revision: 2 }, observation: { ...snapshot, snapshotId: "session:2", revision: 2 }, timings: { totalMs: 1 } }
        : snapshot;
      phone.send(JSON.stringify({ id: request.id, ok: true, result, meta: { durationMs: 1 } }));
    });
    client = createWirelessClient(hub);
    const signal = new AbortController().signal;
    const info = await client.execute("get_device_info", {}, signal);
    assert.equal(info.ok, true);
    assert.equal((info.result as any).selectedSerial, "synthetic-phone");
    assert.equal((info.result as any).devices[0].usb, false);
    await client.execute("get_ui_tree", {}, signal);
    const result = await client.execute("act_and_observe", { action: "click_element", arguments: { snapshotId: snapshot.snapshotId, nodeId: "n0" } }, signal);
    assert.equal(result.ok, true);
    assert.equal((result.result as any).observation.snapshotId, "session:2");
    assert.deepEqual(received, ["get_device_info", "get_ui_tree", "act_and_observe"]);
    await client.close();
    assert.equal(hub.status().connected, true);
    client = createWirelessClient(hub);
    assert.equal((await client.execute("get_ui_tree", {}, signal)).ok, true);
  } finally { await client?.close(); phone.terminate(); await hub.close(); }
});
