import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import type { PhoneBridge } from "../src/bridge.js";
import { compactUi, createPhoneClient } from "../src/client-tools.js";

type Json = Record<string, any>;
function node(nodeId: string, overrides: Json = {}): Json {
  return { nodeId, parentId: "root", text: "", contentDescription: "", resourceId: "", className: "android.view.View",
    bounds: [20, 20, 120, 120], clickable: false, scrollable: false, editable: false, enabled: true, password: false,
    visible: true, checkable: false, checked: false, selected: false, focused: false, ...overrides };
}
const root = node("root", { parentId: null, bounds: [0, 0, 400, 600] });
const button = node("button", { text: "工具", clickable: true });
function tree(nodes: Json[] = [root, button], overrides: Json = {}): Json {
  return { snapshotId: "session:1", revision: 1, packageName: "test.synthetic.app", windowId: 4, truncated: false, nodes: structuredClone(nodes), ...overrides };
}
function newer(source: Json): Json {
  return { ...source, snapshotId: "session:2", revision: 8, nodes: source.nodes.map((item: Json) => ({ ...item,
    nodeId: `${item.nodeId}-new`, parentId: item.parentId === null ? null : `${item.parentId}-new` })) };
}
function success(result: unknown) { return { id: "synthetic", ok: true, result, meta: { durationMs: 1 } }; }
function failure(code: string) { return { id: "synthetic", ok: false, error: { code, message: "Synthetic failure", retryable: false }, meta: { durationMs: 1 } }; }
function harness(options: { old?: Json; fresh?: Json; readError?: string; actionError?: string; prepareRead?: () => Promise<void> } = {}) {
  const old = options.old ?? tree();
  const fresh = options.fresh ?? newer(old);
  const calls: { method: string; args: Json }[] = [];
  let reads = 0;
  const bridge: PhoneBridge = { close: async () => {}, call: async (method, args, _timeout, gate) => {
    if (method === "get_ui_tree" && reads > 0) await options.prepareRead?.();
    gate?.(); calls.push({ method, args });
    if (method === "get_ui_tree") {
      if (reads++ === 0) return success(old);
      return options.readError ? failure(options.readError) : success(fresh);
    }
    if (method === "emergency_stop") return success({ stopped: true });
    if (options.actionError) return failure(options.actionError);
    return success({ action: { accepted: true }, observation: { ...fresh, snapshotId: "session:3", revision: 9 } });
  } };
  const client = createPhoneClient(bridge, new Adb());
  const signal = new AbortController().signal;
  return { old, fresh, calls, client, signal,
    read: () => client.execute("get_ui_tree", {}, signal),
    act: (action = "tap_element", args: Json = { snapshotId: old.snapshotId, nodeId: "button" }, customSignal = signal) =>
      client.execute("act_and_observe", { action, arguments: args }, customSignal),
  };
}
async function attempt(options: Parameters<typeof harness>[0] = {}, action = "tap_element", args?: Json) {
  const h = harness(options);
  try { assert.equal((await h.read()).ok, true); return { result: await h.act(action, args), calls: h.calls }; }
  finally { await h.client.close(); }
}
function rejected(actual: Awaited<ReturnType<typeof attempt>>, observation = true) {
  assert.equal(actual.result.ok, false);
  assert.equal((actual.result.error as Json).code, "TARGET_CHANGED");
  assert.equal((actual.result.meta as Json).preflightRead, true);
  assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "get_ui_tree"]);
  assert.equal(!!actual.result.observation, observation);
}

test("fresh preflight permits new node IDs, moved bounds and unrelated empty layouts before exactly one touch", async () => {
  const old = tree([root, button, node("other", { text: "帮助", bounds: [150, 20, 250, 120] })]);
  const fresh = newer(old);
  fresh.nodes[1].bounds = [60, 220, 160, 320];
  fresh.nodes[2].bounds = [180, 220, 280, 320];
  fresh.nodes.push(node("layout-new", { parentId: "root-new", bounds: [0, 0, 400, 600] }));
  const actual = await attempt({ old, fresh });
  assert.equal(actual.result.ok, true);
  assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "get_ui_tree", "act_and_observe"]);
  assert.deepEqual(actual.calls[1]!.args, { maxNodes: 500, maxDepth: 40 });
  assert.deepEqual(actual.calls[2]!.args.arguments, { snapshotId: "session:2", startX: 110, startY: 270, endX: 110, endY: 270, durationMs: 80 });
  assert.equal((actual.result.result as Json).action.targetNodeId, "button-new");
  assert.equal((actual.result.meta as Json).preflightRead, true);
  assert.equal(typeof (actual.result.meta as Json).preflightMs, "number");
});

test("native click, input and scroll rebind only to matching new target state", async () => {
  for (const action of ["click_element", "input_text", "scroll"]) {
    const old = tree([root, { ...button, editable: action === "input_text", scrollable: action === "scroll" }]);
    const args = { snapshotId: old.snapshotId, nodeId: "button", ...(action === "input_text" ? { text: "新的查询" } : {}), ...(action === "scroll" ? { direction: "forward" } : {}) };
    const actual = await attempt({ old }, action, args);
    assert.equal(actual.result.ok, true, action);
    assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "get_ui_tree", "act_and_observe"]);
    assert.deepEqual(actual.calls[2]!.args.arguments, { ...args, snapshotId: "session:2", nodeId: "button-new" });
  }
});

test("ambiguous refreshed candidates and changed clickable-container labels do not dispatch", async () => {
  const fresh = newer(tree());
  fresh.nodes.push({ ...fresh.nodes[1], nodeId: "duplicate", bounds: [200, 20, 300, 120] });
  rejected(await attempt({ fresh }));
  const label = node("label", { parentId: "button", text: "查看详情", bounds: [30, 30, 70, 70] });
  const old = tree([root, { ...button, text: "" }, label]);
  const changed = newer(old);
  changed.nodes[1].text = "立即支付";
  rejected(await attempt({ old, fresh: changed }, "tap_element", { snapshotId: old.snapshotId, nodeId: "label" }));
});

test("same-window page titles and chat recipients are part of target context", async () => {
  for (const action of ["tap_element", "input_text"]) {
    const old = tree([root, node("title", { text: "联系人甲", resourceId: "app:id/title", bounds: [20, 0, 200, 20] }),
      { ...button, text: action === "input_text" ? "" : "查看", editable: action === "input_text" }]);
    const fresh = newer(old);
    fresh.nodes[1].text = "联系人乙";
    rejected(await attempt({ old, fresh }, action, { snapshotId: old.snapshotId, nodeId: "button", ...(action === "input_text" ? { text: "测试内容" } : {}) }));
  }
});

test("changed ancestor context, app, window, service session and backwards revision reject rebinding", async () => {
  for (const override of [{ windowId: 99 }, { packageName: "test.other.app" }, { snapshotId: "other-session:2" }, { revision: 0 }]) {
    rejected(await attempt({ fresh: { ...newer(tree()), ...override } }));
  }
  const old = tree([{ ...root, text: "设置" }, button]);
  const fresh = newer(old);
  fresh.nodes[0].text = "订单详情";
  rejected(await attempt({ old, fresh }));
});

test("input contents, scroll contents and check state changes are new model evidence", async () => {
  const input = tree([root, { ...button, text: "旧查询", editable: true }]);
  const edited = newer(input);
  edited.nodes[1].text = "用户刚输入的内容";
  rejected(await attempt({ old: input, fresh: edited }, "input_text", { snapshotId: input.snapshotId, nodeId: "button", text: "新查询" }));
  const scroll = tree([root, { ...button, scrollable: true }, node("row", { parentId: "button", text: "条目甲" })]);
  const changed = newer(scroll);
  changed.nodes[2].text = "条目乙";
  rejected(await attempt({ old: scroll, fresh: changed }, "scroll", { snapshotId: scroll.snapshotId, nodeId: "button", direction: "forward" }));
  const stateful = tree([root, { ...button, className: "custom.Toggle", checkable: true }]);
  const toggled = newer(stateful);
  toggled.nodes[1].checked = true;
  rejected(await attempt({ old: stateful, fresh: toggled }));
});

test("old APK state omissions and capped semantics retain the original snapshot path", async () => {
  const missing = tree();
  delete missing.nodes[1].checked;
  const capped = tree([root, { ...button, text: "x".repeat(1000) }]);
  for (const old of [missing, capped]) {
    const actual = await attempt({ old });
    assert.equal(actual.result.ok, true);
    assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "act_and_observe"]);
    assert.equal(actual.calls[1]!.args.arguments.snapshotId, "session:1");
    assert.equal((actual.result.meta as Json).preflightRead, undefined);
  }
});

test("fresh missing states, capped text, partial and truncated trees cannot authorize rebinding", async () => {
  const missing = newer(tree());
  delete missing.nodes[1].checked;
  rejected(await attempt({ fresh: missing }));
  const capped = newer(tree());
  capped.nodes[1].text = "x".repeat(1000);
  rejected(await attempt({ fresh: capped }));
  const full = newer(tree());
  rejected(await attempt({ fresh: { ...full, truncated: true } }), false);
  rejected(await attempt({ fresh: { ...full, nodes: undefined, elements: full.nodes } }), false);
});

test("sensitive and invalid original targets are rejected before any preflight; legacy partial native click is unchanged", async () => {
  for (const override of [{ text: "立即支付" }, { enabled: false }]) {
    const actual = await attempt({ old: tree([root, { ...button, ...override }]) });
    assert.equal(actual.result.ok, false);
    assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree"]);
  }
  const full = tree();
  for (const old of [{ ...full, truncated: true }, { ...full, nodes: undefined, elements: full.nodes }]) {
    const native = await attempt({ old, fresh: newer(full) }, "click_element");
    assert.equal(native.result.ok, true);
    assert.deepEqual(native.calls.map((call) => call.method), ["get_ui_tree", "act_and_observe"]);
    const tap = await attempt({ old, fresh: newer(full) });
    assert.equal(tap.result.ok, false);
    assert.deepEqual(tap.calls.map((call) => call.method), ["get_ui_tree"]);
  }
});

test("fresh hit testing is repeated after rebinding; moved overlapping controls do not get tapped", async () => {
  const old = tree([root, button, node("other", { text: "帮助", clickable: true, bounds: [200, 20, 300, 120] })]);
  const fresh = newer(old);
  fresh.nodes[2].bounds = [30, 30, 130, 130];
  rejected(await attempt({ old, fresh }));
});

test("raw swipe, global keys and settings do not add a target preflight", async () => {
  for (const [action, args] of [
    ["swipe", { snapshotId: "session:1", startX: 30, startY: 30, endX: 30, endY: 300, durationMs: 350 }],
    ["press_key", { key: "back" }], ["open_settings", {}],
  ] as [string, Json][]) {
    const actual = await attempt({}, action, args);
    assert.equal(actual.result.ok, true);
    assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "act_and_observe"]);
  }
});

test("unknown action outcome never returns preflight UI as post-action evidence or revives old references", async () => {
  const h = harness({ actionError: "TIMEOUT" });
  try {
    await h.read();
    const result = await h.act();
    assert.equal((result.error as Json).code, "TIMEOUT");
    assert.equal(result.observation, undefined);
    assert.equal((result.meta as Json).localRejection, undefined);
    assert.equal((result.meta as Json).preflightRead, true);
    assert.equal(((await h.act()).error as Json).code, "NO_KNOWN_SNAPSHOT");
    assert.deepEqual(h.calls.map((call) => call.method), ["get_ui_tree", "get_ui_tree", "act_and_observe"]);
  } finally { await h.client.close(); }
});

test("preflight read failure does not send an action or attach an older observation", async () => {
  const actual = await attempt({ readError: "PHONE_DISCONNECTED" });
  assert.equal((actual.result.error as Json).code, "PHONE_DISCONNECTED");
  assert.equal(actual.result.observation, undefined);
  assert.equal((actual.result.meta as Json).preflightRead, true);
  assert.equal((actual.result.meta as Json).localRejection, undefined);
  assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "get_ui_tree"]);
});

test("cancellation, emergency stop and close during preflight prevent the action", async () => {
  for (const operation of ["cancel", "stop", "close"]) {
    let ready!: () => void, release!: () => void;
    const prepared = new Promise<void>((resolve) => { ready = resolve; });
    const h = harness({ prepareRead: async () => { ready(); await new Promise<void>((resolve) => { release = resolve; }); } });
    const abort = new AbortController();
    try {
      await h.read();
      const pending = h.act("tap_element", undefined, abort.signal);
      await prepared;
      if (operation === "cancel") abort.abort();
      else if (operation === "stop") await h.client.execute("emergency_stop", {}, abort.signal);
      else await h.client.close();
      release();
      const result = await pending;
      assert.equal((result.error as Json).code, operation === "cancel" ? "CANCELLED" : operation === "stop" ? "EMERGENCY_STOPPED" : "CLIENT_CLOSED");
      assert.equal(result.observation, undefined);
      assert.equal((result.meta as Json)?.localRejection, undefined);
      assert.ok(!h.calls.some((call) => call.method === "act_and_observe"));
    } finally { await h.client.close(); }
  }
});

test("compaction retains explicit negative checked, selected and focused states", () => {
  const compact = compactUi(tree()) as Json;
  for (const item of compact.nodes) {
    assert.equal(item.checked, false);
    assert.equal(item.selected, false);
    assert.equal(item.focused, false);
    assert.equal(item.checkable, undefined);
  }
});
