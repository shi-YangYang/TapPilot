import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { createPhoneClient } from "../src/client-tools.js";
import type { PhoneBridge } from "../src/bridge.js";
import { snapshot } from "./helpers.js";

type Node = Omit<typeof snapshot.nodes[number], "parentId"> & { parentId: string | null };
function node(nodeId: string, bounds: number[], overrides: Partial<Node> = {}): Node {
  return { ...snapshot.nodes[0]!, nodeId, parentId: "root", text: "", contentDescription: "", resourceId: "", clickable: false, bounds, ...overrides };
}
const root = node("root", [0, 0, 400, 600], { parentId: null });
const ordinary = node("ordinary", [20, 20, 120, 120], { text: "工具", clickable: true });
const sensitive = node("sensitive", [150, 20, 250, 120], { text: "支付入口", clickable: true });

async function invoke(nodes: Node[], options: { startX?: number; startY?: number; endX?: number; endY?: number; truncated?: boolean; partial?: boolean; clickNode?: string; readError?: string } = {}) {
  const full = { ...snapshot, packageName: "test.synthetic.controls", nodes, truncated: options.truncated ?? false };
  const observed = options.partial ? { ...full, nodes: undefined, elements: nodes } : full;
  const calls: string[] = [];
  const bridge: PhoneBridge = { close: async () => {}, call: async (method) => {
    calls.push(method);
    return { id: "synthetic", ok: true, result: method === "get_ui_tree" ? observed : { action: { accepted: true }, observation: { ...full, snapshotId: "session:2", revision: 2 } }, meta: { durationMs: 1 } };
  } };
  const client = createPhoneClient(bridge, new Adb());
  const signal = new AbortController().signal;
  try {
    const initial = await client.execute("get_ui_tree", {}, signal);
    if (options.readError) {
      assert.equal((initial.error as { code: string }).code, options.readError);
      return { result: initial, calls };
    }
    assert.equal(initial.ok, true);
    const startX = options.startX ?? 30;
    const startY = options.startY ?? 30;
    const result = await client.execute("act_and_observe", options.clickNode ? {
      action: "click_element", arguments: { snapshotId: snapshot.snapshotId, nodeId: options.clickNode },
    } : {
      action: "swipe", arguments: { snapshotId: snapshot.snapshotId, startX, startY, endX: options.endX ?? startX, endY: options.endY ?? startY, durationMs: 80 },
    }, signal);
    return { result, calls };
  } finally { await client.close(); }
}
function blocked(actual: Awaited<ReturnType<typeof invoke>>, code: string) {
  assert.equal(actual.result.ok, false);
  assert.equal((actual.result.error as { code: string }).code, code);
  assert.deepEqual(actual.calls, ["get_ui_tree"], "blocked gestures must not reach the phone");
}

test("tap on an ordinary target excludes sensitive siblings beneath full-screen ancestors", async () => {
  for (const clickable of [false, true]) {
    const actual = await invoke([{ ...root, clickable }, ordinary, sensitive]);
    assert.equal(actual.result.ok, true);
    assert.deepEqual(actual.calls, ["get_ui_tree", "act_and_observe"]);
  }
});

test("tap directly on a sensitive control is blocked", async () => {
  blocked(await invoke([root, ordinary, sensitive], { startX: 160 }), "MANUAL_ACTION_REQUIRED");
});

test("tap on button padding still checks sensitive descendant labels outside the touch point", async () => {
  const label = node("label", [70, 70, 110, 110], { parentId: ordinary.nodeId, text: "立即支付" });
  blocked(await invoke([root, { ...ordinary, text: "" }, label]), "MANUAL_ACTION_REQUIRED");
});

test("containing ancestors retain their own sensitive-label protection", async () => {
  blocked(await invoke([{ ...root, text: "提交订单" }, ordinary]), "MANUAL_ACTION_REQUIRED");
});

test("unrelated overlapping clickable controls do not guess an action target", async () => {
  const overlap = node("overlap", [25, 25, 125, 125], { clickable: true, text: "帮助" });
  blocked(await invoke([root, ordinary, overlap]), "NODE_NOT_ACTIONABLE");
  blocked(await invoke([root, ordinary, { ...overlap, clickable: false }]), "NODE_NOT_ACTIONABLE");
});

test("short-gesture hit tests preserve visible competitors outside parent bounds or under hidden parents", async () => {
  const overlap = node("overlap", [20, 20, 120, 120], { clickable: true });
  const hidden = await invoke([root, ordinary, { ...overlap, visible: false }]);
  assert.equal(hidden.result.ok, true);
  for (const extra of [
    [node("hidden", [0, 0, 400, 600], { visible: false }), { ...overlap, visible: true, parentId: "hidden" }],
    [node("container", [200, 200, 300, 300]), { ...overlap, visible: true, parentId: "container" }],
  ]) {
    blocked(await invoke([root, ordinary, ...extra]), "NODE_NOT_ACTIONABLE");
  }
  blocked(await invoke([root, node("hidden", [0, 0, 400, 600], { visible: false }), { ...ordinary, visible: true, parentId: "hidden" }]), "NODE_NOT_ACTIONABLE");
});

test("short-gesture hit tests do not turn empty full-screen layouts into solid overlays", async () => {
  const layout = node("layout", [0, 0, 400, 600], { className: "android.widget.FrameLayout" });
  const bottom = node("bottom", [20, 500, 120, 550], { clickable: true, parentId: "layout" });
  const actual = await invoke([root, ordinary, layout, bottom]);
  assert.equal(actual.result.ok, true);
  assert.deepEqual(actual.calls, ["get_ui_tree", "act_and_observe"]);
});

test("malformed visible sibling geometry cannot certify a short-gesture target", async () => {
  const malformed = node("malformed", [20, 20, 120], { clickable: true });
  blocked(await invoke([root, ordinary, malformed], { readError: "BRIDGE_PROTOCOL_ERROR" }), "BRIDGE_PROTOCOL_ERROR");
  blocked(await invoke([root, ordinary, node("orphan", [200, 200, 250, 250], { parentId: "missing" })]), "NODE_NOT_ACTIONABLE");
});

test("missing, disabled or password targets are not touched", async () => {
  for (const candidate of [{ ...ordinary, clickable: false }, { ...ordinary, enabled: false }, { ...ordinary, password: true }]) {
    blocked(await invoke([root, candidate]), "NODE_NOT_ACTIONABLE");
  }
});

test("short gesture must end inside the same unique target", async () => {
  const left = { ...ordinary, bounds: [20, 20, 40, 120] };
  const right = { ...sensitive, bounds: [40, 20, 60, 120] };
  blocked(await invoke([root, left, right], { startX: 35, endX: 45 }), "NODE_NOT_ACTIONABLE");
  blocked(await invoke([root, left], { startX: 35, endX: 45 }), "NODE_NOT_ACTIONABLE");
  blocked(await invoke([root, left], { startX: 35, endX: 40 }), "NODE_NOT_ACTIONABLE");
});

test("short gesture endpoint labels are checked even within the same clickable target", async () => {
  const label = node("end-label", [40, 20, 60, 60], { text: "支付", parentId: "root" });
  blocked(await invoke([root, ordinary, label], { startX: 35, endX: 45 }), "MANUAL_ACTION_REQUIRED");
});

test("partial or truncated trees cannot authorize a touch fallback", async () => {
  blocked(await invoke([root, ordinary], { partial: true }), "NODE_NOT_ACTIONABLE");
  blocked(await invoke([root, ordinary], { truncated: true }), "NODE_NOT_ACTIONABLE");
});

test("native click preserves protection of its clickable ancestor and descendant labels", async () => {
  const child = node("child", [20, 20, 50, 50], { parentId: ordinary.nodeId, text: "确认" });
  const label = node("label", [70, 70, 110, 110], { parentId: ordinary.nodeId, text: "支付订单" });
  blocked(await invoke([root, { ...ordinary, text: "" }, child, label], { clickNode: child.nodeId }), "MANUAL_ACTION_REQUIRED");
});
