import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import type { PhoneBridge } from "../src/bridge.js";
import { compactUi, createPhoneClient } from "../src/client-tools.js";
import { prepareTargetRefresh, rebindRefreshedTarget } from "../src/client-target-refresh.js";
import { AgentError } from "../src/errors.js";

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

function listing(): Json {
  return tree([
    root,
    node("title", { text: "商品列表", bounds: [0, 0, 300, 25] }),
    node("list", { scrollable: true, className: "androidx.recyclerview.widget.RecyclerView", bounds: [0, 30, 400, 580] }),
    node("item-a", { parentId: "list", text: "条目甲", resourceId: "app:id/row", className: "android.view.ViewGroup", clickable: true, bounds: [10, 40, 390, 240] }),
    node("price-a", { parentId: "item-a", text: "¥100", bounds: [20, 60, 100, 90] }),
    node("name-a", { parentId: "item-a", text: "商品甲", clickable: true, bounds: [20, 100, 150, 130] }),
    { ...button, parentId: "item-a", bounds: [20, 160, 120, 220] },
    node("item-b", { parentId: "list", text: "条目乙", resourceId: "app:id/row", className: "android.view.ViewGroup", clickable: true, bounds: [10, 300, 390, 560] }),
    node("status-b", { parentId: "item-b", text: "库存 10", bounds: [20, 320, 150, 350] }),
    node("button-b", { parentId: "item-b", clickable: true, bounds: [20, 400, 150, 450] }),
    node("button-label-b", { parentId: "button-b", text: "了解详情", bounds: [30, 410, 140, 440] }),
  ]);
}
function row(source: Json, id: string): Json { return source.nodes.find((entry: Json) => entry.nodeId === id)!; }

test("an identified independent collection row may update a label before one whole-item click", async () => {
  for (const [action, nodeId] of [["tap_element", "item-a"], ["tap_element", "price-a"], ["click_element", "item-a"]]) {
    const old = listing(), fresh = newer(old);
    row(fresh, "status-b-new").text = "库存 9";
    const actual = await attempt({ old, fresh }, action, { snapshotId: old.snapshotId, nodeId });
    assert.equal(actual.result.ok, true);
    assert.deepEqual(actual.calls.map((call) => call.method), ["get_ui_tree", "get_ui_tree", "act_and_observe"]);
    if (action === "tap_element") assert.equal((actual.result.result as Json).action.targetNodeId, `${nodeId}-new`);
  }
});

test("the selected whole row and global titles remain protected when a sibling label changes", async () => {
  for (const [id, text] of [["price-a", "¥200"], ["name-a", "商品乙"], ["title", "联系人乙"]]) {
    const old = listing(), fresh = newer(old);
    row(fresh, "status-b-new").text = "库存 9";
    row(fresh, `${id}-new`).text = text;
    // Every label inside the selected item, including its nested controls,
    // remains exact even when another identified item has a dynamic label.
    rejected(await attempt({ old, fresh }, "tap_element", { snapshotId: old.snapshotId, nodeId: "item-a" }));
  }
});

test("independent row identity, nested control labels, state and exact skeleton must stay unchanged", async () => {
  const changes: ((fresh: Json) => void)[] = [
    (fresh) => { row(fresh, "item-b-new").text = "另一条目"; },
    (fresh) => { row(fresh, "button-label-b-new").text = "另一操作"; },
    (fresh) => { row(fresh, "button-b-new").enabled = false; },
    (fresh) => { row(fresh, "status-b-new").selected = true; },
    (fresh) => { row(fresh, "status-b-new").visible = false; },
    (fresh) => { fresh.nodes.push(node("new-label", { parentId: "item-b-new", text: "新增内容", bounds: [20, 460, 150, 490] })); },
    (fresh) => { fresh.nodes = fresh.nodes.filter((entry: Json) => entry.nodeId !== "button-b-new" && entry.nodeId !== "button-label-b-new"); },
    (fresh) => { const index = fresh.nodes.findIndex((entry: Json) => entry.nodeId === "status-b-new"); fresh.nodes.push(...fresh.nodes.splice(index, 1)); },
  ];
  for (const change of changes) {
    const old = listing(), fresh = newer(old);
    row(fresh, "status-b-new").text = "库存 9";
    change(fresh);
    rejected(await attempt({ old, fresh }, "tap_element", { snapshotId: old.snapshotId, nodeId: "item-a" }));
  }
});

test("unidentified, duplicate or reordered row groups do not authorize text relaxation", async () => {
  for (const variant of ["unidentified", "duplicate", "reordered"]) {
    const old = listing();
    if (variant === "unidentified") row(old, "item-b").text = "";
    if (variant === "duplicate") row(old, "item-b").text = "条目甲";
    const fresh = newer(old);
    row(fresh, "status-b-new").text = "库存 9";
    if (variant === "reordered") {
      const index = fresh.nodes.findIndex((entry: Json) => entry.nodeId === "item-a-new");
      fresh.nodes.push(...fresh.nodes.splice(index, 1));
    }
    rejected(await attempt({ old, fresh }, "tap_element", { snapshotId: old.snapshotId, nodeId: "item-a" }));
  }
});

test("overlapping rows, escaped labels and new occluding controls cannot be treated as independent updates", async () => {
  for (const variant of ["overlap", "escaped", "overlay"]) {
    const old = listing(), fresh = newer(old);
    row(fresh, "status-b-new").text = "库存 9";
    if (variant === "overlap") row(fresh, "item-b-new").bounds = [10, 100, 390, 560];
    if (variant === "escaped") row(fresh, "status-b-new").bounds = [20, 170, 100, 210];
    if (variant === "overlay") fresh.nodes.push(node("overlay", { parentId: "root-new", text: "新浮层", clickable: true, bounds: [20, 160, 120, 220] }));
    rejected(await attempt({ old, fresh }, "tap_element", { snapshotId: old.snapshotId, nodeId: "item-a" }));
  }
});

test("a target outside the identified list keeps the original strict page context", async () => {
  const old = listing();
  Object.assign(row(old, "button"), { parentId: "root", bounds: [310, 0, 390, 25] });
  const fresh = newer(old);
  row(fresh, "status-b-new").text = "库存 9";
  rejected(await attempt({ old, fresh }));
});

test("ScrollView and RecyclerView recipient forms keep input and embedded-button context strict", async () => {
  for (const className of ["android.widget.ScrollView", "androidx.recyclerview.widget.RecyclerView"]) {
    for (const action of ["input_text", "tap_element", "click_element"]) {
      const old = listing();
      row(old, "list").className = className;
      row(old, "item-a").text = "留言";
      row(old, "item-b").text = "收件人";
      row(old, "status-b").text = "联系人甲";
      if (action === "input_text") Object.assign(row(old, "button"), { text: "", editable: true, clickable: false });
      const fresh = newer(old);
      row(fresh, "status-b-new").text = "联系人乙";
      rejected(await attempt({ old, fresh }, action, {
        snapshotId: old.snapshotId, nodeId: "button", ...(action === "input_text" ? { text: "测试内容" } : {}),
      }));
    }
  }
});

test("generic scrollable groups and nonclickable product cards retain strict context", async () => {
  for (const variant of ["generic", "nonclickable-item", "nonclickable-card-title"]) {
    const old = listing();
    if (variant === "generic") row(old, "list").className = "android.widget.ScrollView";
    if (variant === "nonclickable-item") row(old, "item-b").clickable = false;
    if (variant === "nonclickable-card-title") row(old, "item-a").clickable = false;
    const fresh = newer(old);
    row(fresh, "status-b-new").text = "库存 9";
    if (variant === "nonclickable-card-title") row(fresh, "name-a-new").text = "商品乙";
    rejected(await attempt({ old, fresh }, "tap_element", {
      snapshotId: old.snapshotId, nodeId: variant === "nonclickable-card-title" ? "button" : "item-a",
    }));
  }
});

test("nonclickable fields and controls cannot acquire the whole-item navigation exception", async () => {
  for (const action of ["tap_element", "click_element"]) {
    for (const capability of ["editable", "checkable", "scrollable"]) {
      const old = listing();
      row(old, "price-a")[capability] = true;
      const fresh = newer(old);
      row(fresh, "status-b-new").text = "联系人乙";
      rejected(await attempt({ old, fresh }, action, { snapshotId: old.snapshotId, nodeId: "price-a" }));
    }
  }
});

test("target-refresh errors give fixed reasons without retaining UI labels", () => {
  const old = tree(), target = { snapshotId: old.snapshotId, nodeId: "button" };
  const reference = prepareTargetRefresh(old, target, "tap_element")!;
  const cases: [string, (fresh: Json) => void][] = [
    ["TREE_INCOMPLETE", (fresh) => { fresh.truncated = true; }],
    ["TREE_INCOMPLETE", (fresh) => { delete fresh.nodes[1].checked; }],
    ["SESSION_CHANGED", (fresh) => { fresh.snapshotId = "new-session:1"; }],
    ["SESSION_CHANGED", (fresh) => { fresh.revision = 0; }],
    ["WINDOW_CHANGED", (fresh) => { fresh.windowId = 99; }],
    ["TARGET_IDENTITY_CHANGED", (fresh) => { fresh.nodes[1].text = "另一个目标"; }],
    ["TARGET_IDENTITY_CHANGED", (fresh) => { fresh.nodes[1].enabled = false; }],
    ["TARGET_AMBIGUOUS", (fresh) => { fresh.nodes.push({ ...fresh.nodes[1], nodeId: "duplicate" }); }],
    ["PAGE_CONTEXT_CHANGED", (fresh) => { fresh.nodes.push(node("title", { parentId: "root-new", text: "新页面标题" })); }],
  ];
  for (const [reason, change] of cases) {
    const fresh = newer(old);
    change(fresh);
    assert.throws(() => rebindRefreshedTarget(reference, fresh, target), (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.code, "TARGET_CHANGED");
      assert.deepEqual(error.details, { reason });
      return true;
    });
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
