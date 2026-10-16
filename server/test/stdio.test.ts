import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("real SDK stdio initializes, lists strict tool schemas and returns structured errors", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env as Record<string, string>, ADB_PATH: "/nonexistent/tappilot-test-adb", TAPPILOT_APPROVAL_MODE: "manual" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "tappilot-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    assert.equal(tools.find((tool) => tool.name === "input_text")?.inputSchema.additionalProperties, false);
    assert.ok(tools.find((tool) => tool.name === "swipe")?.inputSchema.required?.includes("snapshotId"));
    const screenshot = await client.callTool({ name: "take_screenshot", arguments: {} });
    assert.equal(screenshot.isError, true);
    assert.equal((screenshot.structuredContent as any).error.code, "NOT_IMPLEMENTED");
    const stop = await client.callTool({ name: "emergency_stop", arguments: {} });
    assert.equal((stop.structuredContent as any).error.code, "PHONE_STOP_UNCONFIRMED");
    const home = await client.callTool({ name: "press_key", arguments: { key: "home" } });
    assert.equal((home.structuredContent as any).error.code, "EMERGENCY_STOPPED");
    assert.ok(stderr.includes('"method":"take_screenshot"'));
    assert.ok(!stderr.includes("/nonexistent"));
  } finally { await client.close(); }
});

test("trusted startup exposes consistent tool metadata and keeps tool schemas strict", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: {
      ...process.env as Record<string, string>, ADB_PATH: "/nonexistent/tappilot-test-adb",
      TAPPILOT_APPROVAL_MODE: "trusted", TAPPILOT_SERIAL: "synthetic-test-phone",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "tappilot-trusted-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions() ?? "", /trusted/i);
    assert.doesNotMatch(client.getInstructions() ?? "", /Ask the human to use the local approval CLI/);
    const { tools } = await client.listTools();
    for (const name of ["click_element", "input_text", "swipe"]) {
      const tool = tools.find((entry) => entry.name === name)!;
      assert.match(tool.description ?? "", /trusted/i);
      assert.doesNotMatch(tool.description ?? "", /require.*human.*approv|approval is mandatory|Requires the human's/);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const invalid = await client.callTool({ name: "click_element", arguments: { snapshotId: "synthetic:1", nodeId: "n0", approved: true } });
    assert.equal(invalid.isError, true);
    const unknown = await client.callTool({ name: "click_element", arguments: { snapshotId: "synthetic:1", nodeId: "n0" } });
    assert.equal((unknown.structuredContent as any).error.code, "NO_KNOWN_SNAPSHOT");
  } finally { await client.close(); }
});
