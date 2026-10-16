import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, testModel, RuntimeError, type AgentTool, type ModelConfig, type ModelFetch } from "../src/runtime/index.js";

const model: ModelConfig = { baseUrl: "https://synthetic-model.invalid/v1", model: "synthetic-model", apiKey: "synthetic-test-key" };
const tools: AgentTool[] = [{ name: "get_ui_tree", description: "Read synthetic UI", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const response = (content: string | null, toolCalls?: unknown[]) => new Response(JSON.stringify({ choices: [{
  finish_reason: toolCalls ? "tool_calls" : "stop",
  message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
}] }), { headers: { "Content-Type": "application/json" } });

test("connection test uses the supplied model transport and preserves request restrictions", async () => {
  let requests = 0;
  const modelFetch: ModelFetch = async (url, init) => {
    requests++;
    assert.equal(url, "https://synthetic-model.invalid/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-test-key");
    assert.equal(JSON.parse(String(init.body)).tools, undefined);
    return response("OK");
  };
  assert.equal((await testModel(model, undefined, modelFetch)).ok, true);
  assert.equal(requests, 1);
});

test("every agent turn uses the supplied model transport", async () => {
  let requests = 0;
  let observations = 0;
  const modelFetch: ModelFetch = async () => ++requests === 1 ? response(null, [{
    id: "synthetic-read", type: "function", function: { name: "get_ui_tree", arguments: "{}" },
  }]) : response("读取完成");
  const result = await runAgent({ task: "Read synthetic UI", model, tools, modelFetch,
    execute: async () => ({ ok: true, result: { snapshotId: `synthetic:${++observations}`, packageName: "synthetic.fixture", windowId: 4,
      truncated: false, nodes: [{ text: `Synthetic screen ${observations}` }] } }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.answer, "读取完成");
  assert.equal(result.metrics.modelRequests, 2);
  assert.equal(requests, 2);
  assert.equal(observations, 3);
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(result.metrics.completionReads, 1);
});

test("injected transport failures are redacted and never retried", async () => {
  let requests = 0;
  const modelFetch: ModelFetch = async () => { requests++; throw new Error("synthetic-test-key private UI"); };
  await assert.rejects(testModel(model, undefined, modelFetch), error => error instanceof RuntimeError &&
    error.code === "MODEL_CONNECTION_FAILED" && !/synthetic-test-key|private UI/.test(error.message));
  assert.equal(requests, 1);
});

test("injected transport receives cancellation and still enforces response limits", async () => {
  const controller = new AbortController();
  const reason = new Error("Synthetic cancellation");
  const modelFetch: ModelFetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    controller.abort(reason);
  });
  await assert.rejects(testModel(model, controller.signal, modelFetch), error => error === reason);
  await assert.rejects(testModel(model, undefined, async () => response("x".repeat(513 * 1024))),
    error => error instanceof RuntimeError && error.code === "MODEL_RESPONSE_LIMIT");
});
