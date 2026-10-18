import assert from "node:assert/strict";
import test from "node:test";
import { Adb } from "../src/adb.js";
import { ApprovalQueue } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { createPhoneClient } from "../src/client-tools.js";
import { AgentError } from "../src/errors.js";
import { navigationResultSchema } from "../src/navigation-contract.js";
import { ToolController, toolSchemas } from "../src/tools.js";

type Json = Record<string, any>;
const node = (id: string, extra: Json = {}): Json => ({ nodeId: id, parentId: null, text: "", contentDescription: "",
  resourceId: "test:id/root", className: "android.view.View", bounds: [0, 0, 400, 800], clickable: false, scrollable: false,
  editable: false, enabled: true, visible: true, password: false, ...extra });
const tree = (revision = 1, page = 0, extra: Json = {}): Json => ({ executor: "node-v1", snapshotId: `session:${revision}`,
  revision, windowId: 4, packageName: "test.launcher", observationContract: "semantic-v1", truncated: false,
  quality: { status: "usable", reason: "accessible_content", readableCount: 1, actionableCount: 1 },
  nodes: [node(`root-${revision}`), node(`title-${revision}`, { parentId: `root-${revision}`, resourceId: "test:id/title", text: `Page ${page}` }),
    node(`list-${revision}`, { parentId: `root-${revision}`, resourceId: "test:id/list", scrollable: true, bounds: [0, 60, 400, 760] }),
    ...(page === 2 ? [node(`target-${revision}`, { parentId: `root-${revision}`, resourceId: "test:id/target", text: "Destination", clickable: true })] : [])], ...extra });
const ok = (result: unknown) => ({ id: "synthetic", ok: true, result, meta: { durationMs: 0 } });
const accepted = (observation: Json, extra: Json = {}): Json => ({ action: { accepted: true, action: "swipe", completion: "completed" },
  execution: { dispatch: "sent", acceptance: "accepted", effect: "changed", verification: "unverified" }, observation,
  timings: { actionMs: 1, waitMs: 1, observationMs: 1, totalMs: 3 }, ...extra });
const args = (extra: Json = {}): Json => ({ snapshotId: "session:1", mode: "swipe", direction: "left", stopWhen: { resourceId: "test:id/target" }, maxSteps: 4, ...extra });
const body = (value: Awaited<ReturnType<ToolController["invoke"]>>): Json => value.structuredContent!;
function fixture(pages: Json[], options: { failAt?: number; failure?: unknown; refusalObservation?: Json; mode?: "manual" | "trusted";
    resultPatch?: Json; onAction?: (count: number) => void | Promise<void> } = {}) {
  let current = pages[0]!, index = 0;
  const calls: Array<{ method: string; params?: Json }> = [];
  const bridge: PhoneBridge = { close: async () => {}, call: async (method, params, _timeout, beforeDispatch) => {
    beforeDispatch?.(); calls.push({ method, params });
    if (method === "emergency_stop") return ok({ stopped: true });
    if (method === "get_ui_tree") return ok(current);
    assert.equal(method, "act_and_observe"); index++;
    if (index === options.failAt) {
      if (options.failure) throw options.failure;
      return { id: "synthetic", ok: false, error: { code: "TARGET_CHANGED", message: "Synthetic target changed", retryable: true,
        details: { executor: "node-v1", dispatchState: "not_sent" } }, observation: options.refusalObservation, meta: { durationMs: 0 } };
    }
    current = pages[index] ?? tree(index + 1, index + 10);
    await options.onAction?.(index);
    return ok(accepted(current, options.resultPatch));
  } };
  const controller = new ToolController(bridge, new Adb(), new ApprovalQueue(), options.mode ?? "trusted");
  return { controller, bridge, calls, setCurrent: (value: Json) => { current = value; },
    actions: () => calls.filter(call => call.method === "act_and_observe") };
}
async function run(pages: Json[], request: Json = {}, options: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(pages, options);
  try {
    await f.controller.invoke("get_ui_tree", {});
    const result = body(await f.controller.invoke("navigate_until", args({ snapshotId: pages[0]!.snapshotId, ...request })));
    if (result.ok) assert.equal(navigationResultSchema.safeParse(result.result.navigation).success, true);
    return { result, calls: f.calls, actions: f.actions() };
  } finally { await f.controller.close(); }
}

test("bounded navigation finds the second page with new handles and one observation per action", async () => {
  const out = await run([tree(), tree(2, 1), tree(3, 2)]);
  assert.deepEqual(out.result.result.navigation, { completedSteps: 2, stopReason: "target_found", targetFound: true });
  assert.equal(out.result.result.action.accepted, true);
  assert.equal(out.result.result.observation.snapshotId, "session:3");
  assert.deepEqual(out.actions.map(call => call.params!.arguments.snapshotId), ["session:1", "session:2"]);
  assert.deepEqual(out.actions[0]!.params, { action: "swipe", arguments: { snapshotId: "session:1", startX: 320, startY: 400, endX: 80, endY: 400, durationMs: 350 }, waitMs: 350 });
  assert.deepEqual(out.calls.map(call => call.method), ["get_ui_tree", "get_ui_tree", "act_and_observe", "act_and_observe"]);
});

test("an already visible target returns fresh evidence with zero actions", async () => {
  const out = await run([tree(1, 2)]);
  assert.deepEqual(out.result.result.navigation, { completedSteps: 0, stopReason: "target_found", targetFound: true });
  assert.equal(out.result.result.action.accepted, false); assert.equal(out.actions.length, 0);
  assert.equal(out.calls.filter(call => call.method === "get_ui_tree").length, 2);
});

test("text and description candidates stop on the intermediate page without claiming an exact target", async () => {
  for (const [stopWhen, label] of [
    [{ textContains: "SyntheticChat" }, { contentDescription: "SyntheticChat, 2 unread messages" }],
    [{ contentDescription: "SyntheticChat" }, { text: "SyntheticChat" }],
    [{ text: "SyntheticChat" }, { contentDescription: "Social folder: SyntheticChat, Notes" }],
  ] as const) {
    const candidatePage = tree(2, 1);
    candidatePage.nodes.push(node("candidate-2", { parentId: "root-2", clickable: true, ...label }));
    const out = await run([tree(), candidatePage, tree(3, 3)], { stopWhen });
    assert.deepEqual(out.result.result.navigation, { completedSteps: 1, stopReason: "target_candidate", targetFound: false, candidateNodeIds: ["candidate-2"] });
    assert.equal(out.actions.length, 1); assert.equal(out.result.result.observation.snapshotId, "session:2");
  }
  assert.equal(navigationResultSchema.safeParse({ completedSteps: 0, stopReason: "target_candidate", targetFound: false }).success, false);
  assert.equal(navigationResultSchema.safeParse({ completedSteps: 0, stopReason: "target_found", targetFound: true, candidateNodeIds: ["old"] }).success, false);
});

test("labels with an actionable ancestor stop as candidates before any further gesture", async () => {
  for (const capability of ["clickable", "scrollable"] as const) {
    for (const initial of [true, false]) {
      const page = tree(initial ? 1 : 2, 1);
      page.nodes.push(node("control", { parentId: `root-${initial ? 1 : 2}`, [capability]: true }),
        node("label", { parentId: "control", resourceId: "test:id/label", text: "SyntheticChat" }));
      const out = await run(initial ? [page] : [tree(), page, tree(3, 3)],
        { stopWhen: { text: "SyntheticChat", [capability]: true, resourceId: "test:id/label" } });
      assert.deepEqual(out.result.result.navigation, { completedSteps: initial ? 0 : 1, stopReason: "target_candidate",
        targetFound: false, candidateNodeIds: ["label"] });
      assert.equal(out.actions.length, initial ? 0 : 1);
      assert.ok(out.actions.every(call => call.params!.action === "swipe"), "candidate discovery never clicks a label or its parent");
      assert.equal(out.result.result.observation.snapshotId, page.snapshotId);
    }
  }
});

test("ancestor capabilities do not loosen candidate identity, editor or protected-path checks", async () => {
  const page = tree();
  page.nodes.push(node("control", { parentId: "root-1", clickable: true, editable: true, resourceId: "test:id/control" }),
    node("label", { parentId: "control", text: "SyntheticChat", resourceId: "test:id/label" }));
  for (const constraint of [{ resourceId: "test:id/control" }, { className: "android.widget.Button" }, { editable: true }]) {
    const out = await run([page, tree(2, 1)], { maxSteps: 1, stopWhen: { text: "SyntheticChat", clickable: true, ...constraint } });
    assert.equal(out.result.result.navigation.stopReason, "max_steps");
    assert.equal(out.actions.length, 1);
  }
  page.nodes.find((entry: Json) => entry.nodeId === "control")!.password = true;
  const protectedResult = await run([page], { stopWhen: { text: "SyntheticChat", clickable: true } });
  assert.equal(protectedResult.result.result.navigation.stopReason, "target_blocked");
  assert.equal(protectedResult.result.result.navigation.candidateNodeIds, undefined);
  assert.equal(protectedResult.actions.length, 0);
});

test("hidden and unavailable candidates are ignored; visible protected candidates stop without exposing handles", async () => {
  const makeCandidate = (patch: Json) => {
    const page = tree();
    page.nodes.push(node("candidate", { parentId: "root-1", contentDescription: "SyntheticChat, unread", clickable: true, ...patch }));
    return page;
  };
  for (const patch of [{ visible: false }, { enabled: false }, { parentId: "absent" }]) {
    const out = await run([makeCandidate(patch), tree(2, 1)], { stopWhen: { text: "SyntheticChat" }, maxSteps: 1 });
    assert.equal(out.result.result.navigation.stopReason, "max_steps"); assert.equal(out.actions.length, 1);
  }
  for (const patch of [{ password: true }, { contextProtected: true }, { dataSensitive: true }, { accessibilityDataSensitive: true }]) {
    const out = await run([makeCandidate(patch)], { stopWhen: { text: "SyntheticChat" } });
    assert.equal(out.result.result.navigation.stopReason, "target_blocked"); assert.equal(out.actions.length, 0);
    assert.equal(out.result.result.navigation.candidateNodeIds, undefined);
  }
  const constrained = await run([makeCandidate({ resourceId: "wrong:id" }), tree(2, 1)],
    { stopWhen: { text: "SyntheticChat", resourceId: "wanted:id" }, maxSteps: 1 });
  assert.equal(constrained.result.result.navigation.stopReason, "max_steps");
});

test("explored direction edges survive Home, raw swipes and changed step limits while a new direction remains available", async () => {
  const f = fixture([tree(), tree(2, 1), tree(3, 0), tree(4, 3), tree(5, 0)]);
  try {
    await f.controller.invoke("get_ui_tree", {});
    const first = body(await f.controller.invoke("navigate_until", args({ maxSteps: 1 })));
    assert.equal(first.result.navigation.completedSteps, 1);
    await f.controller.invoke("press_key", { key: "home" });
    const repeated = body(await f.controller.invoke("navigate_until", args({ snapshotId: "session:3", maxSteps: 4 })));
    assert.deepEqual(repeated.result.navigation, { completedSteps: 0, stopReason: "already_explored", targetFound: false });
    assert.equal(f.actions().length, 2);
    const reverse = body(await f.controller.invoke("navigate_until", args({ snapshotId: "session:3", direction: "right", maxSteps: 1 })));
    assert.equal(reverse.result.navigation.completedSteps, 1); assert.equal(f.actions().length, 3);
    await f.controller.invoke("swipe", { snapshotId: "session:4", startX: 320, startY: 400, endX: 80, endY: 400 });
    const again = body(await f.controller.invoke("navigate_until", args({ snapshotId: "session:5", maxSteps: 2 })));
    assert.equal(again.result.navigation.stopReason, "already_explored"); assert.equal(f.actions().length, 4);
  } finally { await f.controller.close(); }
});

test("candidate and exact discoveries do not erase explored edges, and changed target content is inspected before old edges", async () => {
  const f = fixture([tree(), tree(2, 1)]);
  const stopWhen = { text: "SyntheticChat", clickable: true };
  try {
    await f.controller.invoke("get_ui_tree", {});
    await f.controller.invoke("navigate_until", args({ stopWhen, maxSteps: 1 }));
    for (const [revision, label, reason] of [
      [10, { contentDescription: "SyntheticChat, unread" }, "target_candidate"],
      [11, { text: "SyntheticChat" }, "target_found"],
    ] as const) {
      const page = tree(revision, 0);
      page.nodes.push(node(`candidate-${revision}`, { parentId: `root-${revision}`, clickable: true, ...label }));
      f.setCurrent(page); await f.controller.invoke("get_ui_tree", {});
      const out = body(await f.controller.invoke("navigate_until", args({ snapshotId: page.snapshotId, stopWhen })));
      assert.equal(out.result.navigation.stopReason, reason); assert.equal(out.result.navigation.completedSteps, 0);
    }
    f.setCurrent(tree(12, 0)); await f.controller.invoke("get_ui_tree", {});
    const repeated = body(await f.controller.invoke("navigate_until", args({ snapshotId: "session:12", stopWhen: { clickable: true, text: "SyntheticChat" } })));
    assert.equal(repeated.result.navigation.stopReason, "already_explored"); assert.equal(f.actions().length, 1);
  } finally { await f.controller.close(); }
});

test("using the discovered exact or candidate target with observed effect closes only that search for later tasks", async () => {
  for (const candidate of [false, true]) {
    const targetPage = tree(2, 1);
    targetPage.nodes.push(node("target-2", { parentId: "root-2", clickable: true,
      ...(candidate ? { contentDescription: "Destination, unread" } : { text: "Destination" }) }));
    const f = fixture([tree(), targetPage, tree(3, 9, { packageName: "opened.app", windowId: 9 }), tree(4, 0), tree(5, 1)]);
    const stopWhen = { text: "Destination" };
    try {
      await f.controller.invoke("get_ui_tree", {});
      const found = body(await f.controller.invoke("navigate_until", args({ stopWhen })));
      assert.equal(found.result.navigation.stopReason, candidate ? "target_candidate" : "target_found");
      await f.controller.invoke("tap_element", { snapshotId: "session:2", nodeId: "target-2" });
      await f.controller.invoke("press_key", { key: "home" });
      const later = body(await f.controller.invoke("navigate_until", args({ snapshotId: "session:4", stopWhen, maxSteps: 1 })));
      assert.equal(later.result.navigation.completedSteps, 1); assert.equal(later.result.navigation.stopReason, "max_steps");
      assert.equal(f.actions().length, 4);
    } finally { await f.controller.close(); }
  }
});

test("unrelated target actions and accepted touches without observed effect cannot reset a discovered search", async () => {
  for (const scenario of ["unrelated", "unchanged", "identical_observation", "new_handles"] as const) {
    const targetPage = tree(2, 2);
    targetPage.nodes.push(node("other-2", { parentId: "root-2", clickable: true, text: "Another action" }));
    const samePage = tree(3, 2);
    samePage.nodes.push(node("other-3", { parentId: "root-3", clickable: true, text: "Another action" }));
    const f = fixture([tree(), targetPage, scenario === "identical_observation" ? samePage : tree(3, 9), tree(4, 0)],
      scenario === "unchanged" ? { resultPatch: { execution: { dispatch: "sent", acceptance: "accepted", effect: "unchanged", verification: "unverified" } } } : {});
    try {
      await f.controller.invoke("get_ui_tree", {});
      await f.controller.invoke("navigate_until", args());
      let snapshotId = "session:2", nodeId = scenario === "unrelated" ? "other-2" : "target-2";
      if (scenario === "new_handles") {
        f.setCurrent(tree(10, 2)); await f.controller.invoke("get_ui_tree", {});
        snapshotId = "session:10"; nodeId = "target-10";
      }
      await f.controller.invoke("tap_element", { snapshotId, nodeId });
      await f.controller.invoke("press_key", { key: "home" });
      const later = body(await f.controller.invoke("navigate_until", args({ snapshotId: "session:4", maxSteps: 1 })));
      assert.equal(later.result.navigation.stopReason, "already_explored", scenario); assert.equal(f.actions().length, 3);
    } finally { await f.controller.close(); }
  }
});

test("native scroll resolves its container selector against every fresh tree", async () => {
  const out = await run([tree(), tree(2, 1), tree(3, 2)], { mode: "scroll", direction: "forward", container: { resourceId: "test:id/list" } });
  assert.equal(out.result.result.navigation.targetFound, true);
  assert.deepEqual(out.actions.map(call => call.params!.arguments.nodeId), ["list-1", "list-2"]);
});

test("repeated semantic pages and A-B-A loops stop despite changing snapshot/node handles", async () => {
  for (const [pages, expected] of [[ [tree(), tree(2, 0)], 1 ], [ [tree(), tree(2, 1), tree(3, 0)], 2 ]] as const) {
    const out = await run([...pages]); assert.equal(out.result.result.navigation.stopReason, "no_progress"); assert.equal(out.actions.length, expected);
  }
  const out = await run([tree(), tree(2, 1)], {}, { resultPatch: { execution: { dispatch: "sent", acceptance: "accepted", effect: "unchanged", verification: "unverified" } } });
  assert.equal(out.result.result.navigation.stopReason, "no_progress"); assert.equal(out.actions.length, 1);
});

test("maximum steps is bounded and schema rejects unbounded/visual/click attempts", async () => {
  const out = await run([tree(), tree(2, 3), tree(3, 4), tree(4, 5), tree(5, 6)]);
  assert.equal(out.result.result.navigation.stopReason, "max_steps"); assert.equal(out.actions.length, 4);
  for (const patch of [{ maxSteps: 0 }, { maxSteps: 5 }, { mode: "tap_element" }, { mode: "swipe_visual" }, { stopWhen: {} }, { captureId: "image" }]) {
    assert.equal(toolSchemas.navigate_until.safeParse(args(patch)).success, false);
  }
});

test("changed session/package/window stops before a second action even if target appears", async () => {
  for (const patch of [{ snapshotId: "new-session:2" }, { packageName: "other.app" }, { windowId: 99 }]) {
    const out = await run([tree(), tree(2, 2, patch)]);
    assert.equal(out.result.result.navigation.stopReason, "scope_changed"); assert.equal(out.result.result.navigation.targetFound, false); assert.equal(out.actions.length, 1);
  }
});

test("unavailable, incomplete or settling trees cannot authorize bounded navigation", async () => {
  for (const patch of [{ truncated: true }, { truncated: undefined },
    { quality: { status: "unavailable", reason: "no_accessible_content", readableCount: 0, actionableCount: 0 } },
    { readiness: { status: "settling", reason: "deadline", samples: 2, waitedMs: 400 } }]) {
    for (const afterStep of [false, true]) {
      const out = await run(afterStep ? [tree(), tree(2, 1, patch)] : [tree(1, 0, patch)]);
      assert.equal(out.result.result.navigation.stopReason, "observation_unavailable"); assert.equal(out.actions.length, afterStep ? 1 : 0);
    }
  }
});

test("ambiguous/disabled targets and ambiguous scroll containers stop without touching", async () => {
  const base = tree(1, 2), target = base.nodes.at(-1)!;
  for (const [nodes, reason] of [[ [...base.nodes, { ...target, nodeId: "duplicate" }], "target_ambiguous" ],
    [ [...base.nodes.slice(0, -1), { ...target, enabled: false }], "target_blocked" ]] as const) {
    const out = await run([tree(1, 2, { nodes })]); assert.equal(out.result.result.navigation.stopReason, reason); assert.equal(out.actions.length, 0);
  }
  const withTwoLists = tree(); withTwoLists.nodes.push({ ...withTwoLists.nodes[2], nodeId: "duplicate-list" });
  const out = await run([withTwoLists], { mode: "scroll", direction: "forward", container: { scrollable: true } });
  assert.equal(out.result.result.navigation.stopReason, "container_unavailable"); assert.equal(out.actions.length, 0);
});

test("a second-step native refusal preserves the first acceptance and fresh refusal UI, never replaying", async () => {
  const out = await run([tree(), tree(2, 1)], {}, { failAt: 2, refusalObservation: tree(3, 3) });
  assert.equal(out.result.ok, true); assert.equal(out.result.result.action.accepted, true);
  assert.equal(out.result.result.navigation.completedSteps, 1); assert.equal(out.result.result.navigation.stopReason, "action_failed");
  assert.equal(out.result.result.navigation.error.code, "TARGET_CHANGED"); assert.equal(out.result.result.navigation.error.retryable, false);
  assert.equal(out.result.result.navigation.uncertainStep, undefined); assert.equal(out.result.result.observation.snapshotId, "session:3"); assert.equal(out.actions.length, 2);
});

test("uncertain transport and accepted-action observation failures keep partial evidence without stale UI", async () => {
  const out = await run([tree(), tree(2, 1)], {}, { failAt: 2, failure: new AgentError("BRIDGE_TIMEOUT", "Synthetic transport loss") });
  assert.equal(out.result.result.navigation.completedSteps, 1); assert.equal(out.result.result.navigation.error.code, "BRIDGE_TIMEOUT");
  assert.equal(out.result.result.navigation.uncertainStep, true); assert.equal(out.result.result.action.accepted, true);
  assert.equal(out.result.result.observation, null); assert.equal(out.actions.length, 2);
  const missing = await run([tree(), tree(2, 1)], {}, { resultPatch: { observation: null,
    observationError: { code: "COMMAND_TIMEOUT", message: "Synthetic observation failure", retryable: true } } });
  assert.equal(missing.result.result.navigation.error.code, "COMMAND_TIMEOUT"); assert.equal(missing.result.result.navigation.uncertainStep, true); assert.equal(missing.actions.length, 1);
});

test("manual mode cannot expand a single-action approval into bounded navigation", async () => {
  const out = await run([tree()], {}, { mode: "manual" }); assert.equal(out.result.error.code, "CONFIRMATION_REQUIRED"); assert.equal(out.actions.length, 0);
});

test("desktop cancellation and emergency stop prevent subsequent steps while preserving acceptance", async () => {
  const abort = new AbortController();
  const f = fixture([tree(), tree(2, 1)], { onAction: count => { if (count === 1) abort.abort(); } });
  const client = createPhoneClient(f.bridge, new Adb());
  try {
    await client.execute("get_ui_tree", {}, abort.signal);
    const out = await client.execute("navigate_until", args(), abort.signal) as Json;
    assert.equal(out.result.action.accepted, true); assert.equal(out.result.navigation.completedSteps, 1);
    assert.equal(out.result.navigation.error.code, "CANCELLED"); assert.equal(out.result.observation, null); assert.equal(f.actions().length, 1);
  } finally { await client.close(); await f.controller.close(); }
  let stopped!: ReturnType<typeof fixture>;
  stopped = fixture([tree(), tree(2, 1)], { onAction: async count => { if (count === 1) await stopped.controller.invoke("emergency_stop", {}); } });
  try {
    await stopped.controller.invoke("get_ui_tree", {});
    const out = body(await stopped.controller.invoke("navigate_until", args()));
    assert.equal(out.result.action.accepted, true); assert.equal(stopped.actions().length, 1);
  } finally { await stopped.controller.close(); }
});

test("desktop and MCP controller use the same bounded dispatch sequence", async () => {
  const expected = await run([tree(), tree(2, 1), tree(3, 2)]), f = fixture([tree(), tree(2, 1), tree(3, 2)]);
  const client = createPhoneClient(f.bridge, new Adb());
  try {
    assert.ok(client.tools.some(tool => tool.name === "navigate_until")); const signal = new AbortController().signal;
    await client.execute("get_ui_tree", {}, signal);
    const out = await client.execute("navigate_until", args(), signal) as Json;
    assert.deepEqual(out.result.navigation, expected.result.result.navigation); assert.deepEqual(f.actions(), expected.actions);
  } finally { await client.close(); await f.controller.close(); }
});
