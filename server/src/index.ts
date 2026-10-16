import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Adb } from "./adb.js";
import { ApprovalQueue } from "./approvals.js";
import { Bridge } from "./bridge.js";
import { createMcpServer, ToolController } from "./tools.js";
import { readRuntimeConfig } from "./config.js";
import { publicError } from "./errors.js";

let config;
try { config = readRuntimeConfig(process.env); }
catch (error) {
  const safe = publicError(error);
  process.stderr.write(JSON.stringify({ status: safe.code, message: safe.message }) + "\n");
  process.exit(1);
}
const adb = new Adb({ executable: config.adbPath, serial: config.serial, allowEmulator: config.allowEmulator });
const controller = new ToolController(new Bridge(adb), adb, new ApprovalQueue(), config.approvalMode);
const server = createMcpServer(controller);
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  await controller.close();
  await server.close();
  clearTimeout(timer);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.stdin.once("end", () => { void shutdown(); });
process.once("uncaughtException", () => {
  process.stderr.write('{"status":"UNCAUGHT_ERROR"}\n');
  process.exitCode = 1;
  void shutdown();
});
process.once("unhandledRejection", () => {
  process.stderr.write('{"status":"UNHANDLED_ERROR"}\n');
  process.exitCode = 1;
  void shutdown();
});

server.connect(new StdioServerTransport()).catch(async () => {
  process.stderr.write('{"status":"MCP_START_FAILED"}\n');
  process.exitCode = 1;
  await shutdown();
});
