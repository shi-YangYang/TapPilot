import { createInterface } from "node:readline";
import { SkillStore } from "../../src/skills/store.js";

const [root, operation, serialized] = process.argv.slice(2);
if (!root || !operation || !serialized) throw new Error("INVALID_TEST_WORKER_ARGUMENTS");
const args = JSON.parse(serialized), store = new SkillStore(root);
let ran = false;
const lines = createInterface({ input: process.stdin });
process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`);
for await (const line of lines) {
  if (line === "close") break;
  if (line !== "run" || ran) throw new Error("INVALID_TEST_WORKER_COMMAND");
  ran = true;
  let value: unknown;
  if (operation === "claim") {
    value = (await store.beginJob(args.modelProfile, args.now))?.job ?? null;
  } else if (operation === "reserve") {
    let reserved = 0;
    const errors: string[] = [];
    for (let index = 0; index < args.calls; index++) {
      try { await store.reserveModelCall(args.jobId, args.now, 150); reserved++; }
      catch (error) { errors.push(error instanceof Error ? error.message : "UNKNOWN_TEST_ERROR"); }
    }
    value = { reserved, errors };
  } else throw new Error("INVALID_TEST_WORKER_OPERATION");
  process.stdout.write(`${JSON.stringify({ type: "result", value })}\n`);
}
lines.close();
