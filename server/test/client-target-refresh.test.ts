import assert from "node:assert/strict";
import test from "node:test";
import { prepareTargetRefresh, rebindRefreshedTarget } from "../src/client-target-refresh.js";
import { AgentError } from "../src/errors.js";

// Reference model for synthetic evaluation only. Android executor behavior is
// verified by the model-free testbed, not by this TypeScript implementation.
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
test("synthetic target-reference errors give fixed reasons without retaining UI labels", () => {
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
      if (reason === "PAGE_CONTEXT_CHANGED") {
        assert.deepEqual(error.details, { reason, contextChange: { region: "unknown", kind: "structure", changedNodes: 0, targetMatched: true, actionTargetMatched: true } });
      } else assert.deepEqual(error.details, { reason });
      return true;
    });
  }
});
