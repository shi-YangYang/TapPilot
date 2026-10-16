import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { ApprovalQueue } from "../src/approvals.js";
import { approvalCommand, grant } from "./helpers.js";

test("approvals are private, bound to exact payload, single use and expire", async () => {
  let now = 1000;
  const queue = new ApprovalQueue(() => now);
  try {
    const args = { snapshotId: "s", nodeId: "n", text: "你好" };
    const prompt = (await queue.require("input_text", args, { packageName: "test.app", text: "Recipient" }))!;
    assert.equal((await stat(dirname(prompt.socketPath))).mode & 0o777, 0o700);
    assert.equal((await stat(prompt.socketPath)).mode & 0o777, 0o600);
    assert.equal((await queue.require("input_text", { text: "你好", nodeId: "n", snapshotId: "s" }, {}))?.approvalId, prompt.approvalId);
    assert.equal((await approvalCommand(prompt.socketPath, { op: "approve", approvalId: prompt.approvalId, challenge: "forged" })).ok, false);
    const inspected = await grant(prompt);
    assert.equal(inspected.params.text, "你好");
    assert.equal(inspected.preview.text, "Recipient");
    assert.ok(await queue.require("input_text", { ...args, text: "changed" }, {}));
    assert.equal(await queue.require("input_text", args, {}), undefined);
    assert.equal((await approvalCommand(prompt.socketPath, { op: "approve", approvalId: prompt.approvalId, challenge: inspected.challenge })).ok, false);
    const replay = (await queue.require("input_text", args, {}))!;
    assert.notEqual(replay.approvalId, prompt.approvalId);
    await grant(replay);
    now += 120_001;
    assert.notEqual((await queue.require("input_text", args, {}))!.approvalId, replay.approvalId);
    queue.clear();
    assert.equal((await approvalCommand(prompt.socketPath, { op: "inspect", approvalId: replay.approvalId })).ok, false);
  } finally { await queue.close(); }
});
