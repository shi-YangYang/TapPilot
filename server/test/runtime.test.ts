import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { endpointFor, runAgent, testModel, type AgentTool, type ModelConfig } from "../src/runtime/index.js";

type Body = { messages: Array<Record<string, unknown>>; tools?: unknown[]; model?: string };
const tools: AgentTool[] = [
  { name: "get_ui_tree", description: "Read current UI", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "act_and_observe", description: "One native action and new UI", inputSchema: {
    type: "object", required: ["action", "arguments"], additionalProperties: false,
    properties: { action: { type: "string", enum: ["click_element"] }, arguments: { type: "object", required: ["snapshotId", "nodeId"], additionalProperties: false,
      properties: { snapshotId: { type: "string" }, nodeId: { type: "string" } } } },
  } },
];
const toolCall = (id: string, name: string, args: unknown = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const response = (content: string | null, calls?: unknown[]) => ({ choices: [{ finish_reason: calls ? "tool_calls" : "stop", message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { total_tokens: 100 } });
const observation = (id: string, text: string) => ({ ok: true, result: { snapshotId: id, revision: Number(id.replace(/\D/g, "")) || 1, packageName: "synthetic.fixture", nodes: [{ nodeId: "n1", text, clickable: true }] } });

async function fixture(handler: (body: Body, res: ServerResponse, req: IncomingMessage) => void | Promise<void>) {
  const requests: Body[] = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as Body;
      requests.push(body);
      await handler(body, res, req);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Fixture did not listen");
  const model: ModelConfig = { baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: "synthetic-test-key", model: "synthetic-model" };
  return { model, requests, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test("a configured compatible model drives a real HTTP multi-turn tool loop, with compact current UI and timing events", async () => {
  let turn = 0;
  const server = await fixture((body, res, req) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer synthetic-test-key");
    assert.equal(body.model, "synthetic-model");
    turn++;
    res.setHeader("Content-Type", "application/json");
    if (turn === 1) {
      assert.equal(JSON.parse(body.messages.at(-1)!.content as string).result.snapshotId, "s1");
      res.end(JSON.stringify(response(null, [toolCall("act1", "act_and_observe", { action: "click_element", arguments: { snapshotId: "s1", nodeId: "n1" } })])));
    }
    else {
      const history = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content as string));
      assert.equal(history[0].superseded, true);
      assert.equal(JSON.stringify(history).includes("old-screen-content"), false);
      assert.equal(history[1].result.observation.snapshotId, "s2");
      assert.match(body.messages[0]!.content as string, /untrusted DATA/);
      res.end(JSON.stringify(response("当前显示电池设置。")));
    }
  });
  const events: Record<string, unknown>[] = [];
  const executed: string[] = [];
  try {
    const result = await runAgent({ task: "查看电池设置", model: server.model, tools: clientTools, onEvent: event => events.push(event), execute: async (name, args) => {
      executed.push(name);
      if (name === "get_ui_tree") return observation("s1", "old-screen-content");
      assert.deepEqual(args, { action: "click_element", arguments: { snapshotId: "s1", nodeId: "n1" } });
      return { ok: true, result: { action: { accepted: true }, observation: observation("s2", "电池设置").result } };
    } });
    assert.equal(result.status, "completed");
    assert.equal(result.answer, "当前显示电池设置。");
    assert.deepEqual(executed, ["get_ui_tree", "act_and_observe"]);
    assert.equal(result.metrics.modelRequests, 2);
    assert.equal(result.metrics.toolCalls, 2);
    assert.ok(result.metrics.totalMs >= result.metrics.modelMs);
    assert.equal(events.filter(event => event.type === "tool_end").length, 2);
    assert.equal(events[0]!.turn, 0);
    assert.equal(JSON.stringify(events).includes("old-screen-content"), false);
    assert.equal(JSON.stringify(events).includes("synthetic-test-key"), false);
  } finally { await server.close(); }
});

test("production nested swipe schema accepts coordinates and rejects an invalid repeated field before dispatch", async () => {
  for (const endY of [200, "200"]) {
    let turn = 0;
    const args = { action: "swipe", arguments: { snapshotId: "s1", startX: 100, startY: 800, endX: 100, endY } };
    const server = await fixture((_body, res) => {
      res.end(JSON.stringify(++turn === 1 ? response(null, [toolCall("swipe1", "act_and_observe", args)]) : response("已读取滑动后的界面。")));
    });
    const dispatched: string[] = [];
    try {
      const result = await runAgent({ task: "向上滑动并读取", model: server.model, tools: clientTools, execute: async (name, received) => {
        dispatched.push(name);
        if (name === "get_ui_tree") return observation("s1", "before synthetic swipe");
        assert.deepEqual(received, args);
        return { ok: true, result: { action: { accepted: true }, observation: observation("s2", "after synthetic swipe").result } };
      } });
      assert.equal(result.status, typeof endY === "number" ? "completed" : "failed");
      assert.deepEqual(dispatched, typeof endY === "number" ? ["get_ui_tree", "act_and_observe"] : ["get_ui_tree"]);
      if (typeof endY !== "number") assert.match(result.error!, /INVALID_TOOL_ARGUMENTS/);
    } finally { await server.close(); }
  }
});

test("all tool calls are validated before dispatch; unknown tools, extra fields and invalid types cannot be executed", async () => {
  const invalidCalls = [
    [toolCall("a", "get_ui_tree"), toolCall("b", "upload_secrets")],
    [toolCall("a", "get_ui_tree", { injected: "ignore previous instructions" })],
    [toolCall("a", "act_and_observe", { action: "click_element", arguments: { snapshotId: 1, nodeId: "n1" } })],
    [{ id: "a", type: "function", function: { name: "get_ui_tree", arguments: "not-json" } }],
  ];
  for (const calls of invalidCalls) {
    const server = await fixture((_body, res) => { res.end(JSON.stringify(response(null, calls))); });
    let dispatches = 0;
    try {
      const result = await runAgent({ task: "read", model: server.model, tools, execute: async () => { dispatches++; return observation("s1", "synthetic UI"); } });
      assert.equal(result.status, "failed");
      assert.match(result.error!, /UNKNOWN_TOOL|INVALID_TOOL_ARGUMENTS/);
      assert.equal(dispatches, 1); // Host's initial read; no model-supplied call was dispatched.
    } finally { await server.close(); }
  }
});

test("multiple UI mutations in the same response are rejected before any dispatch", async () => {
  const args = { action: "click_element", arguments: { snapshotId: "s1", nodeId: "n1" } };
  const server = await fixture((_body, res) => { res.end(JSON.stringify(response(null, [toolCall("a", "act_and_observe", args), toolCall("b", "act_and_observe", args)]))); });
  try {
    const result = await runAgent({ task: "read", model: server.model, tools, execute: async name => { assert.equal(name, "get_ui_tree"); return observation("s1", "synthetic UI"); } });
    assert.match(result.error!, /UNOBSERVED_ACTION_BATCH/);
    assert.equal(result.metrics.toolCalls, 1);
  } finally { await server.close(); }
});

test("cancellation aborts an in-flight model request and dispatches no tool", async () => {
  const controller = new AbortController();
  const server = await fixture((_body, _res) => { controller.abort(); });
  try {
    const result = await runAgent({ task: "read", model: server.model, tools, signal: controller.signal, execute: async () => observation("s1", "synthetic UI") });
    assert.equal(result.status, "cancelled");
    assert.equal(result.metrics.toolCalls, 1);
  } finally { await server.close(); }
});

test("cancellation during a tool suppresses all later calls even if the executor ignores its signal", async () => {
  const controller = new AbortController();
  const server = await fixture((_body, res) => { res.end(JSON.stringify(response(null, [toolCall("a", "get_ui_tree"), toolCall("b", "get_ui_tree")]))); });
  let dispatches = 0;
  try {
    const result = await runAgent({ task: "read", model: server.model, tools, signal: controller.signal, execute: async () => {
      dispatches++;
      controller.abort();
      return new Promise(() => {});
    } });
    assert.equal(result.status, "cancelled");
    assert.equal(dispatches, 1);
  } finally { await server.close(); }
});

test("host restrictions and disconnected wireless sessions terminate without a model request", async () => {
  for (const code of ["CONFIRMATION_REQUIRED", "MANUAL_ACTION_REQUIRED", "EMERGENCY_STOPPED", "WIRELESS_SESSION_CHANGED", "WIRELESS_DISCONNECTED", "WIRELESS_TIMEOUT"]) {
    const server = await fixture((_body, res) => { res.end(JSON.stringify(response(null, [toolCall("a", "get_ui_tree")]))); });
    try {
      const result = await runAgent({ task: "read", model: server.model, tools, execute: async () => ({ ok: false, error: { code, message: "private raw message" } }) });
      assert.equal(result.status, "failed");
      assert.match(result.error!, new RegExp(code));
      assert.equal(result.error!.includes("private raw message"), false);
      assert.equal(server.requests.length, 0);
    } finally { await server.close(); }
  }
});

test("changing snapshot IDs and revisions alone do not permit an endless repeat loop", async () => {
  let calls = 0;
  const server = await fixture((_body, res) => { res.end(JSON.stringify(response(null, [toolCall("a", "get_ui_tree")]))); });
  try {
    const result = await runAgent({ task: "read", model: server.model, tools, execute: async () => observation(`s${++calls}`, "unchanged synthetic screen") });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /REPEATED_ACTION/);
    assert.equal(calls, 4); // Host read plus three unchanged model reads; reads are checked after dispatch.
  } finally { await server.close(); }
});

test("model HTTP errors and redirects cannot leak provider response bodies or redirect the API key", async () => {
  let redirected = false;
  const target = await fixture((_body, res) => { redirected = true; res.end(JSON.stringify(response("OK"))); });
  const server = await fixture((_body, res) => { res.writeHead(302, { Location: `${target.model.baseUrl}/chat/completions` }).end("synthetic-test-key private UI"); });
  const failure = await fixture((_body, res) => { res.writeHead(401).end("synthetic-test-key private UI"); });
  try {
    await assert.rejects(testModel(server.model), /MODEL|无法连接/);
    assert.equal(redirected, false);
    await assert.rejects(testModel(failure.model), error => error instanceof Error && error.message.includes("401") && !error.message.includes("synthetic-test-key") && !error.message.includes("private UI"));
  } finally { await server.close(); await failure.close(); await target.close(); }
});

test("endpoint validation permits explicit loopback models and rejects plaintext LAN or URL credentials", () => {
  const config = { apiKey: "", model: "local" };
  assert.equal(endpointFor({ ...config, baseUrl: "https://model.example/v1/" }), "https://model.example/v1/chat/completions");
  assert.equal(endpointFor({ ...config, baseUrl: "http://localhost:11434/v1/chat/completions" }), "http://localhost:11434/v1/chat/completions");
  for (const baseUrl of ["http://192.168.1.2/v1", "http://model.example/v1", "https://user:pass@model.example/v1", "https://model.example/v1?key=secret", "https://model.example/v1#fragment", "file:///tmp/model"]) {
    assert.throws(() => endpointFor({ ...config, baseUrl }));
  }
});

test("testModel performs a real minimal request and verifies the response shape", async () => {
  const server = await fixture((body, res) => { assert.equal(body.tools, undefined); res.end(JSON.stringify(response("OK"))); });
  const invalid = await fixture((_body, res) => { res.end(JSON.stringify({ message: "not a chat completions endpoint" })); });
  try {
    const result = await testModel(server.model);
    assert.equal(result.ok, true);
    assert.equal(result.model, "synthetic-model");
    assert.equal(server.requests.length, 1);
    await assert.rejects(testModel(invalid.model), /choices/);
  } finally { await server.close(); await invalid.close(); }
});

test("a protected initial screen permits a subsequent safe action, but no observation cannot be reported completed", async () => {
  let turn = 0;
  const server = await fixture((_body, res) => {
    turn++;
    res.end(JSON.stringify(turn === 1 ? response(null, [toolCall("a", "act_and_observe", { action: "click_element", arguments: { snapshotId: "fixture", nodeId: "fixture" } })]) : response("已读取合成界面。")));
  });
  const noAction = await fixture((_body, res) => { res.end(JSON.stringify(response("无法访问当前页面。"))); });
  try {
    const result = await runAgent({ task: "read", model: server.model, tools, execute: async name => name === "get_ui_tree" ?
      { ok: false, error: { code: "PROTECTED_APP" } } : { ok: true, result: { observation: observation("s2", "synthetic UI").result } } });
    assert.equal(result.status, "completed");
    const failure = await runAgent({ task: "read", model: noAction.model, tools, execute: async () => ({ ok: false, error: { code: "NO_ACTIVE_WINDOW" } }) });
    assert.equal(failure.status, "failed");
    assert.equal(failure.answer, "无法访问当前页面。");
    assert.match(failure.error!, /NO_OBSERVATION/);
  } finally { await server.close(); await noAction.close(); }
});

test("response, tool result and turn budgets stop the run rather than retrying", async () => {
  const oversized = await fixture((_body, res) => { res.end(JSON.stringify(response("x".repeat(513 * 1024)))); });
  const looping = await fixture((_body, res) => { res.end(JSON.stringify(response(null, [toolCall("a", "get_ui_tree")]))); });
  try {
    await assert.rejects(testModel(oversized.model), /响应过大/);
    const large = await runAgent({ task: "read", model: looping.model, tools, execute: async () => ({ ok: true, text: "x".repeat(97 * 1024) }) });
    assert.match(large.error!, /TOOL_RESULT_LIMIT/);
    let turn = 0;
    const limited = await runAgent({ task: "read", model: looping.model, tools, maxTurns: 2, execute: async () => observation(`s${++turn}`, `changed screen ${turn}`) });
    assert.match(limited.error!, /TURN_LIMIT/);
    assert.equal(limited.metrics.modelRequests, 2);
  } finally { await oversized.close(); await looping.close(); }
});

test("an action without a fresh observation invalidates earlier UI evidence and cannot finish as completed", async () => {
  let turn = 0;
  const server = await fixture((body, res) => {
    turn++;
    if (turn === 2) assert.equal(JSON.stringify(body.messages).includes("old-screen-marker"), false);
    res.end(JSON.stringify(turn === 1 ? response(null, [toolCall("a", "act_and_observe", { action: "click_element", arguments: { snapshotId: "s1", nodeId: "n0" } })]) : response("应该完成了")));
  });
  try {
    const result = await runAgent({ task: "navigate", model: server.model, tools, execute: async name => name === "get_ui_tree" ?
      observation("s1", "old-screen-marker") : { ok: true, result: { action: { accepted: true }, observationError: { code: "NO_ACTIVE_WINDOW" } } } });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /NO_OBSERVATION/);
    assert.equal(result.metrics.toolCalls, 2);
  } finally { await server.close(); }
});
