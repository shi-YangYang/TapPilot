import { homedir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "./store.js";

// This CLI deliberately exposes only aggregate metadata, never UI or model prose.
async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "summary";
  if (!["summary", "clear"].includes(command) || args.length !== 0 && (args.length !== 2 || args[0] !== "--root")) {
    throw new Error("USAGE");
  }
  const rootDirectory = args[1] ?? join(homedir(), "Library", "Application Support", "TapPilot");
  const store = new DiagnosticStore({ rootDirectory });
  const result = command === "clear" ? await store.clear() : { groups: await store.summarize(), status: store.status() };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (store.status().storageUnavailable || "cleared" in result && !result.cleared) process.exitCode = 1;
}
void main().catch(() => {
  process.stderr.write("诊断命令失败。用法：diagnostics [summary|clear] [--root 桌面数据目录]\n");
  process.exitCode = 1;
});
