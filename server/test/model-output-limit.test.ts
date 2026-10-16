import assert from "node:assert/strict";
import test from "node:test";
import { completion, type ModelConfig } from "../src/runtime/model.js";
import { runAgent } from "../src/runtime/index.js";
import { clientTools } from "../src/client-tools.js";

const config: ModelConfig = { baseUrl: "https://synthetic-model.invalid/v1", model: "fixture", apiKey: "" };
const signal = new AbortController().signal;
const response = (message: unknown, finish_reason = "stop") => new Response(JSON.stringify({
  choices: [{ message, finish_reason }], usage: { total_tokens: 100 },
}));

test("model output uses provider defaults even when an older caller supplies an output limit", async () => {
  for (const limit of [undefined, 2048, 16384, 0, null]) {
    let requests = 0;
    const legacyConfig = { ...config, maxOutputTokens: limit };
    await completion(legacyConfig, [{ role: "user", content: "Synthetic task" }], [], signal, async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init.body));
      for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) assert.equal(field in body, false);
      assert.equal(body.thinking, undefined);
      assert.equal(body.reasoning_effort, undefined);
      return response({ role: "assistant", content: "Done" });
    });
    assert.equal(requests, 1);
  }
});

test("truncated tool arguments and final answers never execute actions, retry or claim completion", async () => {
  const call = { id: "synthetic-tap", type: "function", function: { name: "act_and_observe", arguments: JSON.stringify({
    action: "tap_element", arguments: { snapshotId: "synthetic:1", nodeId: "n1" },
  }) } };
  for (const message of [
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "assistant", content: "Synthetic unfinished final answer" },
  ]) {
    let requests = 0;
    const executed: string[] = [];
    const result = await runAgent({ task: "Synthetic task", model: config, tools: clientTools,
      execute: async name => {
        executed.push(name);
        return { ok: true, result: { snapshotId: "synthetic:1", truncated: false, nodes: [{ nodeId: "n1", text: "Synthetic button", clickable: true }] } };
      },
      modelFetch: async () => { requests++; return response(message, "length"); },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /MODEL_OUTPUT_LIMIT.*模型服务截断了回复/);
    assert.doesNotMatch(result.error!, /模型页|调整上限|16384/);
    assert.equal(result.answer, "");
    assert.equal(requests, 1);
    assert.deepEqual(executed, ["get_ui_tree"], "only initial observation; no mutation or replay");
  }
});
