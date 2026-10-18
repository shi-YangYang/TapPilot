import assert from "node:assert/strict";
import test from "node:test";
import { clientTools } from "../src/client-tools.js";
import { fullObservation } from "../src/runtime/context.js";
import { runAgent } from "../src/runtime/index.js";

type Json = Record<string, any>;
type PlannedCall = { name: string; args: Json };
type Frame = ReturnType<typeof frame>;
const frame = (revision: number, nodes: Json[]) => ({ snapshotId: `decision-fixture:${revision}`, revision,
  packageName: "synthetic.fixture", windowId: 4, truncated: false, nodes });
const node = (nodeId: string, text: string, clickable = false) => ({ nodeId, text, clickable,
  enabled: true, visible: true, bounds: [10, 10, 200, 100] });
const initial = frame(1, [node("entry", "第二个应用入口", true)]);
const finish = (snapshotId: string, evidenceNodeIds: string[], answer = "当前任务已完成。") => ({
  name: "finish_task", args: { status: "completed", answer, snapshotId, evidenceNodeIds },
});
const tap = (snapshotId: string, nodeId: string) => ({ name: "act_and_observe",
  args: { action: "tap_element", arguments: { snapshotId, nodeId } } });
const toolResults = (body: Json): Json[] => body.messages.filter((message: Json) => message.role === "tool")
  .map((message: Json) => JSON.parse(message.content));
const currentUi = (body: Json): Json | undefined => toolResults(body).map(fullObservation).filter(Boolean).at(-1);

function assertToolPairs(body: Json) {
  const pending = new Set<string>();
  for (const message of body.messages) {
    if (message.role === "tool") assert.ok(pending.delete(message.tool_call_id));
    else {
      assert.equal(pending.size, 0, "all prior calls need results before a new assistant message");
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0);
}

async function scenario({ task = "读取当前界面的应用入口名称。", frames = [initial], plan }: {
  task?: string; frames?: Frame[]; plan: (turn: number, body: Json) => PlannedCall[];
}) {
  let turn = 0, frameIndex = 0;
  const dispatched: Array<{ name: string; args: Json }> = [];
  const requests: Json[] = [], events: Json[] = [];
  const result = await runAgent({ task, tools: clientTools, maxTurns: 5,
    model: { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" },
    execute: async (name, args) => {
      dispatched.push({ name, args });
      if (name === "get_ui_tree") return { ok: true, result: frames[frameIndex]! };
      assert.equal(name, "act_and_observe", "finish and rejected decisions must never reach the phone");
      assert.ok(frameIndex + 1 < frames.length, "the mock must have an observed post-action frame");
      return { ok: true, result: { action: { accepted: true }, observation: frames[++frameIndex]! } };
    },
    onEvent: event => events.push(event),
    modelFetch: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      assertToolPairs(body);
      requests.push(body);
      const calls = plan(turn++, body).map((call, index) => ({ id: `decision-${turn}-${index}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) } }));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: calls,
      } }] }));
    },
  });
  return { result, dispatched, requests, events };
}

test("finish_task ends from current evidence with only the initial and host final reads", async () => {
  const { result, dispatched, requests } = await scenario({ plan: (turn, body) => {
    assert.equal(turn, 0);
    assert.ok(body.tools.some((tool: Json) => tool.function.name === "finish_task"));
    return [finish(initial.snapshotId, ["entry"], "当前有第二个应用入口。")];
  } });
  assert.equal(result.status, "completed");
  assert.equal(result.answer, "当前有第二个应用入口。");
  assert.deepEqual(dispatched.map(call => call.name), ["get_ui_tree", "get_ui_tree"]);
  assert.equal(result.metrics.completionReads, 1);
  assert.equal(result.metrics.modelRequests, 1);
  assert.equal(requests.length, 1);
});

test("a finish declaration mixed with an action dispatches neither tool", async () => {
  const { result, dispatched } = await scenario({ plan: () => [
    finish(initial.snapshotId, ["entry"]), tap(initial.snapshotId, "entry"),
  ] });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /UNOBSERVED_ACTION_BATCH/);
  assert.deepEqual(dispatched.map(call => call.name), ["get_ui_tree"]);
  assert.equal(result.metrics.modelRequests, 1);
});

test("a hidden redundant read is corrected without a phone read and can be followed by finish", async () => {
  const { result, dispatched, events } = await scenario({ plan: (turn, body) => {
    if (turn === 0) {
      assert.equal(body.tools.some((tool: Json) => tool.function.name === "get_ui_tree"), false);
      return [{ name: "get_ui_tree", args: {} }];
    }
    assert.equal(turn, 1);
    assert.equal(toolResults(body).at(-1)!.error.code, "INVALID_TOOL_ARGUMENTS");
    assert.equal(toolResults(body).at(-1)!.accepted, false);
    assert.equal(currentUi(body)?.snapshotId, initial.snapshotId);
    return [finish(initial.snapshotId, ["entry"])];
  } });
  assert.equal(result.status, "completed");
  assert.deepEqual(dispatched.map(call => call.name), ["get_ui_tree", "get_ui_tree"]);
  assert.equal(result.metrics.completionReads, 1);
  assert.equal(result.metrics.modelRequests, 2);
  assert.equal(events.filter(event => event.type === "model_correction").length, 1);
});

test("a multi-step task continues after app entry and finishes only after its requested detail is observed", async () => {
  const landing = frame(2, [node("heading", "第二个应用"), node("details", "通知详情", true)]);
  const detail = frame(3, [node("notice", "通知详情"), node("time", "活动时间：15:30")]);
  const { result, dispatched } = await scenario({ task: "打开第二个应用入口，查看通知详情并告诉我活动时间。",
    frames: [initial, landing, detail], plan: (turn, body) => {
      const current = currentUi(body)!;
      if (turn === 0) return [tap(initial.snapshotId, "entry")];
      if (turn === 1) {
        assert.equal(current.snapshotId, landing.snapshotId);
        assert.ok(current.nodes.some((item: Json) => item.nodeId === "details"));
        return [tap(landing.snapshotId, "details")];
      }
      assert.equal(turn, 2, "opening the app must not auto-complete the task");
      assert.equal(current.snapshotId, detail.snapshotId);
      assert.ok(current.nodes.some((item: Json) => item.text === "活动时间：15:30"));
      return [finish(detail.snapshotId, ["time"], "活动时间是15:30。")];
    } });
  assert.equal(result.status, "completed");
  assert.equal(result.answer, "活动时间是15:30。");
  assert.deepEqual(dispatched.map(call => call.name), ["get_ui_tree", "act_and_observe", "act_and_observe", "get_ui_tree"]);
  assert.equal(result.metrics.modelRequests, 3);
  assert.equal(result.metrics.completionReads, 1);
});

test("an explicit swipe remains allowed when unrelated buttons are already visible", async () => {
  const before = frame(1, [node("weather", "天气", true), node("camera", "相机", true)]);
  const after = frame(2, [node("page2", "第二页"), node("calculator", "计算器", true)]);
  const swipe = { name: "act_and_observe", args: { action: "swipe", arguments: {
    snapshotId: before.snapshotId, startX: 180, startY: 250, endX: 30, endY: 250, durationMs: 350,
  } } };
  const { result, dispatched } = await scenario({ task: "向左滑动一页，然后告诉我这一页显示的应用。",
    frames: [before, after], plan: (turn, body) => {
      if (turn === 0) {
        const action = body.tools.find((tool: Json) => tool.function.name === "act_and_observe");
        assert.ok(action.function.parameters.properties.action.enum.includes("swipe"));
        return [swipe];
      }
      assert.equal(turn, 1);
      return [finish(after.snapshotId, ["page2", "calculator"], "第二页显示计算器。")];
    } });
  assert.equal(result.status, "completed");
  assert.deepEqual(dispatched.map(call => call.name), ["get_ui_tree", "act_and_observe", "get_ui_tree"]);
  assert.deepEqual(dispatched[1]!.args, swipe.args);
});

test("stale finish evidence is corrected against the retained current UI without extra phone reads", async () => {
  const { result, dispatched, events } = await scenario({ plan: (turn, body) => {
    if (turn === 0) return [finish("decision-fixture:0", ["entry"])];
    assert.equal(turn, 1);
    const correction = toolResults(body).at(-1)!;
    assert.equal(correction.error.code, "INVALID_TOOL_ARGUMENTS");
    assert.equal(correction.accepted, false);
    assert.equal(currentUi(body)?.snapshotId, initial.snapshotId);
    return [finish(initial.snapshotId, ["entry"])];
  } });
  assert.equal(result.status, "completed");
  assert.deepEqual(dispatched.map(call => call.name), ["get_ui_tree", "get_ui_tree"]);
  assert.equal(result.metrics.modelRequests, 2);
  assert.equal(result.metrics.completionReads, 1);
  assert.equal(events.filter(event => event.type === "model_correction").length, 1);
});
