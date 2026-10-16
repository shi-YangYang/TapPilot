import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import type { BridgeResponse, PhoneBridge } from "../src/bridge.js";
import { createPhoneClient } from "../src/client-tools.js";
import { runAgent } from "../src/runtime/index.js";

type Json = Record<string, any>;
type Screen = { title: string; controls: Json[] };
type Step = { action: "tap" | "input_text" | "swipe" | "open_settings"; target?: string; text?: string; next: number; error?: "STALE_SNAPSHOT" };
const model = { baseUrl: "https://synthetic-model.invalid/v1", apiKey: "synthetic-key", model: "fixture" };
const control = (key: string, text: string, overrides: Json = {}): Json => ({ key, text, clickable: true, bounds: [40, 160, 300, 300], ...overrides });
const success = (result: Json): BridgeResponse => ({ id: "synthetic", ok: true, result, meta: { durationMs: 1 } });
const failure = (code: string): BridgeResponse => ({ id: "synthetic", ok: false,
  error: { code, message: "Synthetic fixture refusal", retryable: code === "STALE_SNAPSHOT" }, meta: { durationMs: 1 } });
const contains = (bounds: number[], x: number, y: number) => x >= bounds[0]! && x < bounds[2]! && y >= bounds[1]! && y < bounds[3]!;

/** Only the Android RPC endpoint is synthetic: production client/controller/runtime remain wired together. */
class SyntheticPhone implements PhoneBridge {
  screen = 0;
  protected = false;
  modelRound = 0;
  reads = 0;
  latest?: Json;
  beforeRead?: (phone: SyntheticPhone) => void;
  readonly calls: { method: string; args: Json; round: number }[] = [];
  readonly assertions: unknown[] = [];
  private sequence = 0;
  private nextStep = 0;

  constructor(readonly screens: Screen[], readonly steps: Step[]) {}
  async close() {}

  private snapshot(): Json {
    const screen = this.screens[this.screen]!;
    const revision = ++this.sequence;
    const source = [
      { key: "root", parent: null, text: "", clickable: false, bounds: [0, 0, 400, 600] },
      { key: "title", text: screen.title, clickable: false, bounds: [0, 0, 400, 50] },
      ...screen.controls,
    ];
    const nodes = source.map((item: Json) => {
      const { key, parent, ...value } = item;
      return { nodeId: `${key}-${revision}`, parentId: parent === null ? null : `${parent ?? "root"}-${revision}`,
        text: "", contentDescription: "", resourceId: `synthetic.fixture:id/${key}`, className: "android.view.View",
        clickable: false, scrollable: false, editable: false, enabled: true, password: false,
        visible: true, checkable: false, checked: false, selected: false, focused: false, ...value };
    });
    this.latest = { snapshotId: `synthetic-session:${revision}`, revision, packageName: "synthetic.fixture", windowId: 4,
      truncated: false, nodes };
    return this.latest;
  }

  async call(method: string, args: Json = {}, _timeout?: number, beforeDispatch?: () => void): Promise<BridgeResponse> {
    try {
      beforeDispatch?.();
      this.calls.push({ method, args: structuredClone(args), round: this.modelRound });
      if (method === "get_ui_tree") {
        this.reads++;
        if (this.protected) return failure("PROTECTED_APP");
        this.beforeRead?.(this);
        return success(this.snapshot());
      }
      assert.equal(method, "act_and_observe", "No metadata detours or alternate mutation RPCs are expected");
      assert.equal(this.calls.filter(call => call.method === method && call.round === this.modelRound).length, 1,
        "A model decision must dispatch at most one phone mutation, including refused attempts");
      const step = this.steps[this.nextStep++];
      assert.ok(step, "Unexpected extra phone mutation");
      const actionArgs = args.arguments as Json;
      if (step.action === "open_settings") {
        assert.equal(args.action, "open_settings");
        assert.deepEqual(actionArgs, {});
        assert.equal(this.protected, true);
        this.protected = false;
      } else {
        assert.equal(this.protected, false);
        assert.ok(this.latest);
        assert.equal(actionArgs.snapshotId, this.latest.snapshotId, "Phone RPC must use the latest issued snapshot");
        if (step.action === "input_text") {
          assert.equal(args.action, "input_text");
          const target = this.latest.nodes.find((node: Json) => node.nodeId === actionArgs.nodeId);
          assert.ok(target?.editable);
          assert.equal(target.contentDescription, step.target);
          assert.equal(actionArgs.text, step.text);
        } else {
          assert.equal(args.action, "swipe", "tap_element must reach the phone as one verified touch");
          if (step.action === "tap") {
            assert.equal(actionArgs.startX, actionArgs.endX);
            assert.equal(actionArgs.startY, actionArgs.endY);
            const target = this.latest.nodes.find((node: Json) => node.text === step.target);
            assert.ok(target?.clickable);
            assert.ok(contains(target.bounds, actionArgs.startX, actionArgs.startY));
            for (const other of this.latest.nodes.filter((node: Json) => node.clickable && node !== target)) {
              assert.equal(contains(other.bounds, actionArgs.startX, actionArgs.startY), false,
                "A partially overlapping control must never receive the derived touch");
            }
          } else {
            assert.ok(Math.hypot(actionArgs.endX - actionArgs.startX, actionArgs.endY - actionArgs.startY) > 24);
          }
        }
      }
      this.screen = step.next;
      if (step.error) {
        this.latest = undefined;
        return failure(step.error);
      }
      const observation = this.snapshot();
      return success({ action: { accepted: true, action: args.action, revision: observation.revision,
        ...(args.action === "swipe" ? { completion: "completed" } : {}) }, observation });
    } catch (error) { this.assertions.push(error); throw error; }
  }

  assertAllSteps() { assert.equal(this.nextStep, this.steps.length, "Every expected action must occur exactly once"); }
}

function observations(body: Json): Json[] {
  const found: Json[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const object = value as Json;
    if (typeof object.snapshotId === "string" && Array.isArray(object.nodes)) found.push(object);
    else for (const nested of Object.values(object)) visit(nested);
  }
  for (const message of body.messages.filter((item: Json) => item.role === "tool")) visit(JSON.parse(message.content));
  return found;
}
function choose(observation: Json | undefined, text: string, capability = "clickable"): Json {
  assert.ok(observation, "A model must have current UI evidence before choosing a node");
  const matches = observation.nodes.filter((node: Json) => (node.text === text || node.desc === text) && node[capability] === true);
  assert.equal(matches.length, 1, "Synthetic model chooses one observed label and capability, never a fixed node ID");
  return { snapshotId: observation.snapshotId, nodeId: matches[0].nodeId };
}
const tap = (observation: Json | undefined, text: string): Json => ({ action: "tap_element", arguments: choose(observation, text) });
const pageTitle = (observation: Json | undefined): string | undefined => observation?.nodes.find((node: Json) => node.rid === "id/title")?.text;

async function run(phone: SyntheticPhone, decide: (observation: Json | undefined, body: Json) => Json | undefined) {
  const client = createPhoneClient(phone, new Adb());
  const requests: Json[] = [];
  const events: Json[] = [];
  const assertions: unknown[] = [];
  try {
    const result = await runAgent({ task: "完成合成界面中的导航与读取任务", tools: client.tools, model,
      execute: (name, args, signal) => client.execute(name, args, signal), onEvent: event => events.push(event),
      modelFetch: async (_url, init) => {
        try {
          const body = JSON.parse(init.body as string);
          requests.push(body);
          phone.modelRound++;
          const current = observations(body);
          assert.equal(current.length, phone.protected ? 0 : 1, "Only one complete current UI is sent to each model decision");
          if (current[0]) assert.equal(current[0].snapshotId, phone.latest?.snapshotId);
          assert.equal(body.max_tokens, undefined);
          assert.equal(body.max_completion_tokens, undefined);
          const action = decide(current[0], body);
          return new Response(JSON.stringify({ choices: [{ finish_reason: action ? "tool_calls" : "stop", message: {
            role: "assistant", content: action ? null : "已读取合成目标界面。",
            ...(action ? { tool_calls: [{ id: `call-${phone.modelRound}`, type: "function", function: {
              name: "act_and_observe", arguments: JSON.stringify(action),
            } }] } : {}),
          } }], usage: { total_tokens: 150_000 } }));
        } catch (error) { assertions.push(error); throw error; }
      },
    });
    if (phone.assertions.length) throw phone.assertions[0];
    if (assertions.length) throw assertions[0];
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.metrics.completionReads, 1, "One host read checks the final session, app and window without another model round");
    phone.assertAllSteps();
    assert.equal(new Set(requests.flatMap(body => observations(body).map(tree => tree.snapshotId))).size,
      requests.filter(body => observations(body).length > 0).length, "Every next decision receives a new current snapshot");
    assert.ok(result.metrics.modelUiBytes! < result.metrics.rawUiBytes!, "Production UI projection is used across the client boundary");
    assert.equal(JSON.stringify(events).includes("synthetic-key"), false);
    return { result, requests, events };
  } finally { await client.close(); }
}

test("runtime/client/controller navigate three pages, selecting an unoccluded part of a partially covered button", async () => {
  const phone = new SyntheticPhone([
    { title: "合成首页", controls: [control("tools", "工具入口"), control("overlay", "浮层帮助", { bounds: [140, 180, 220, 280] })] },
    { title: "工具列表", controls: [control("battery", "电池信息")] },
    { title: "电池信息", controls: [control("details", "查看详情")] },
    { title: "电池详情", controls: [control("status", "剩余电量 80%", { clickable: false })] },
  ], [{ action: "tap", target: "工具入口", next: 1 }, { action: "tap", target: "电池信息", next: 2 }, { action: "tap", target: "查看详情", next: 3 }]);
  const { result, requests } = await run(phone, observed => {
    const target = { 合成首页: "工具入口", 工具列表: "电池信息", 电池信息: "查看详情" }[pageTitle(observed) ?? ""];
    return target ? tap(observed, target) : undefined;
  });
  assert.equal(requests.length, 4, "Three actions plus completion; observations need no extra model turns");
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(result.metrics.preflightReads, 3);
  assert.equal(result.metrics.toolCalls, 5);
  assert.deepEqual(phone.calls.map(call => call.method), ["get_ui_tree", "get_ui_tree", "act_and_observe", "get_ui_tree", "act_and_observe", "get_ui_tree", "act_and_observe", "get_ui_tree"]);
  const point = phone.calls.find(call => call.method === "act_and_observe")!.args.arguments;
  assert.notDeepEqual([point.startX, point.startY], [170, 230], "The blocked center is never dispatched");
});

test("Chinese input, search and result navigation consume returned observations through all production layers", async () => {
  const query = "合成电池";
  const editor = (text: string) => control("query", text, { editable: true, contentDescription: "搜索关键词", bounds: [20, 80, 280, 140] });
  const search = control("search", "搜索", { bounds: [290, 80, 380, 140] });
  const phone = new SyntheticPhone([
    { title: "合成搜索", controls: [editor(""), search] },
    { title: "合成搜索", controls: [editor(query), search] },
    { title: "搜索结果", controls: [control("result", "合成结果甲")] },
    { title: "结果详情", controls: [control("info", "合成结果说明", { clickable: false })] },
  ], [{ action: "input_text", target: "搜索关键词", text: query, next: 1 }, { action: "tap", target: "搜索", next: 2 }, { action: "tap", target: "合成结果甲", next: 3 }]);
  const { result } = await run(phone, observed => {
    if (pageTitle(observed) === "合成搜索") {
      const field = observed!.nodes.find((node: Json) => node.editable && node.desc === "搜索关键词");
      return field.text === query ? tap(observed, "搜索") : { action: "input_text", arguments: { ...choose(observed, "搜索关键词", "editable"), text: query } };
    }
    return pageTitle(observed) === "搜索结果" ? tap(observed, "合成结果甲") : undefined;
  });
  assert.equal(result.metrics.modelRequests, 4);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(result.metrics.preflightReads, 3);
  assert.deepEqual(phone.calls.filter(call => call.method === "act_and_observe").map(call => call.args.action), ["input_text", "swipe", "swipe"]);
});

test("an initially protected page offers only the explicit settings exit before normal navigation resumes", async () => {
  const phone = new SyntheticPhone([
    { title: "合成设置", controls: [control("battery", "电池信息")] },
    { title: "合成电池页", controls: [control("status", "状态正常", { clickable: false })] },
  ], [{ action: "open_settings", next: 0 }, { action: "tap", target: "电池信息", next: 1 }]);
  phone.protected = true;
  const { result, events } = await run(phone, (observed, body) => {
    if (!observed) {
      assert.deepEqual(body.tools.map((tool: Json) => tool.function.name), ["act_and_observe"]);
      assert.deepEqual(body.tools[0].function.parameters.properties.action.enum, ["open_settings"]);
      return { action: "open_settings", arguments: {} };
    }
    return pageTitle(observed) === "合成设置" ? tap(observed, "电池信息") : undefined;
  });
  assert.equal(result.metrics.modelRequests, 3);
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(events.filter(event => event.errorCode === "PROTECTED_APP").length, 1);
  assert.deepEqual(phone.calls.map(call => call.method), ["get_ui_tree", "act_and_observe", "get_ui_tree", "act_and_observe", "get_ui_tree"]);
});

test("a stale swipe gets one host read and a new model decision without automatic mutation replay", async () => {
  const phone = new SyntheticPhone([
    { title: "合成列表", controls: [control("list", "可滚动列表", { clickable: false, scrollable: true, bounds: [0, 60, 400, 580] })] },
    { title: "已更新列表", controls: [control("next", "更新后的入口")] },
    { title: "合成终点", controls: [control("status", "已到达", { clickable: false })] },
  ], [{ action: "swipe", next: 1, error: "STALE_SNAPSHOT" }, { action: "tap", target: "更新后的入口", next: 2 }]);
  const { result, events } = await run(phone, observed => {
    if (pageTitle(observed) === "合成列表") {
      const list = observed!.nodes.find((node: Json) => node.scrollable);
      const [left, top, right, bottom] = list.bounds as number[];
      return { action: "swipe", arguments: { snapshotId: observed!.snapshotId,
        startX: Math.floor((left! + right!) / 2), endX: Math.floor((left! + right!) / 2),
        startY: bottom! - 40, endY: top! + 40, durationMs: 350 } };
    }
    return pageTitle(observed) === "已更新列表" ? tap(observed, "更新后的入口") : undefined;
  });
  assert.equal(result.metrics.modelRequests, 3);
  assert.equal(result.metrics.hostReads, 2);
  assert.equal(result.metrics.preflightReads, 1);
  assert.equal(events.filter(event => event.errorCode === "STALE_SNAPSHOT").length, 1);
  assert.deepEqual(phone.calls.map(call => [call.method, call.round]), [
    ["get_ui_tree", 0], ["act_and_observe", 1], ["get_ui_tree", 1], ["get_ui_tree", 2], ["act_and_observe", 2],
    ["get_ui_tree", 3],
  ]);
});

test("a real page-context change refuses the old intent and supplies the new UI for the next model decision", async () => {
  const phone = new SyntheticPhone([
    { title: "旧合成页面", controls: [control("view", "查看详情")] },
    { title: "新合成页面", controls: [control("view", "查看详情")] },
    { title: "新页面详情", controls: [control("status", "新页面信息", { clickable: false })] },
  ], [{ action: "tap", target: "查看详情", next: 2 }]);
  phone.beforeRead = fixture => { if (fixture.reads === 2) fixture.screen = 1; };
  const seen: (string | undefined)[] = [];
  const { result, events } = await run(phone, observed => {
    seen.push(pageTitle(observed));
    return pageTitle(observed) === "新页面详情" ? undefined : tap(observed, "查看详情");
  });
  assert.deepEqual(seen, ["旧合成页面", "新合成页面", "新页面详情"]);
  assert.equal(result.metrics.modelRequests, 3);
  assert.equal(result.metrics.hostReads, 1, "The preflight-refusal observation avoids a recovery read; only the completion check reads again");
  assert.equal(result.metrics.preflightReads, 2);
  assert.equal(events.filter(event => event.errorCode === "TARGET_CHANGED" && event.errorReason === "PAGE_CONTEXT_CHANGED").length, 1);
  assert.deepEqual(phone.calls.map(call => [call.method, call.round]), [
    ["get_ui_tree", 0], ["get_ui_tree", 1], ["get_ui_tree", 2], ["act_and_observe", 2],
    ["get_ui_tree", 3],
  ]);
});
