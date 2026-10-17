import type { BridgeResponse, PhoneBridge } from "../bridge.js";
import type { Scenario } from "./scenarios.js";
import { prepareTargetRefresh, rebindRefreshedTarget, type NodeAction } from "../client-target-refresh.js";
import { touchGeometry, unobstructedTouchPoint, type TouchRect } from "../client-touch-geometry.js";
import { AgentError } from "../errors.js";
import { phoneErrorSchema } from "../bridge.js";
export type Json = Record<string, any>;
export interface BusinessState {
  page: "list" | "form" | "loading" | "detail"; openedProject?: string; enteredText: string;
  wrongActions: number; mutations: number; dispatches: number; scrollOffset: number; focused: boolean;
  protected: boolean; sessionChanged: boolean; cancelled: boolean; responseLost: boolean;
  contextChanged: boolean;
}
const ok = (result: Json): BridgeResponse => ({ id: "eval", ok: true, result, meta: { durationMs: 1 } });
const fail = (code: string): BridgeResponse => ({ id: "eval", ok: false, error: { code, message: "Synthetic endpoint refusal", retryable: code === "STALE_SNAPSHOT" }, meta: { durationMs: 1 } });
const inside = (node: Json, x: number, y: number) => node.visible && x >= node.bounds[0] && x < node.bounds[2] && y >= node.bounds[1] && y < node.bounds[3];

/** Models a business state, not a required sequence. Only this Android endpoint is fake. */
export class ScenarioPhone implements PhoneBridge {
  readonly state: BusinessState;
  readonly calls: { method: string; action?: string }[] = [];
  reads = 0; latest?: Json;
  private revision = 0; private loadingTicks = 0; private movedDuringDispatch = false;
  private readonly snapshots = new Map<string, Json>();
  constructor(readonly scenario: Scenario) {
    this.state = { page: scenario.mechanism === "ime_layout" ? "form" : "list", enteredText: "", wrongActions: 0, mutations: 0, dispatches: 0, scrollOffset: 0, focused: false,
      protected: scenario.mechanism === "cancel_protected" && !scenario.parameters.cancel,
      sessionChanged: false, cancelled: false, responseLost: false, contextChanged: false };
  }
  async close() {}
  cancel() { this.state.cancelled = true; }
  private node(key: string, text: string, overrides: Json = {}): Json {
    return { key, parent: "root", text, contentDescription: "", className: "android.view.View", resourceId: `synthetic.eval:id/${key}`, bounds: [20, 100, 350, 180], clickable: false, editable: false, scrollable: false, enabled: true,
      password: false, visible: true, checkable: false, checked: false, selected: false, focused: false, ...overrides };
  }
  private progressLoading() {
    if (this.state.page === "loading" && --this.loadingTicks <= 0) { this.state.page = "detail"; this.state.openedProject = this.scenario.target; }
  }
  snapshot(): Json {
    const { scenario: s, state: b } = this;
    const rev = ++this.revision;
    const nodes = [this.node("root", "", { parent: null, bounds: [0, 0, 400, 800] }), this.node("title", b.page === "detail" ? "项目详情" : "合成工作台", { bounds: [0, 0, 400, 80] })];
    const x = s.parameters.x, y = s.parameters.y + (s.mechanism === "target_move" && this.reads >= 2 ? (this.movedDuringDispatch ? 85 : 65) : 0);
    if (b.page === "detail") nodes.push(this.node("detail", b.openedProject ?? "", { bounds: [20, 120, 380, 190] }));
    else if (b.page === "loading") nodes.push(this.node("loading", "正在加载", { bounds: [20, 120, 380, 190] }));
    else if (b.page === "form") {
      nodes.push(this.node("editor", b.enteredText, { contentDescription: "项目查询", editable: true, clickable: true, focused: b.focused, bounds: [20, b.focused ? 85 : 140, 350, b.focused ? 140 : 195] }));
      nodes.push(this.node("continue", "查看项目", { clickable: true, bounds: [20, 230, 350, 290] }));
      if (b.focused) nodes.push(this.node("keyboard", "输入法", { bounds: [0, 450, 400, 800] }));
    } else {
      const list = s.mechanism === "unrelated_updates" || s.mechanism === "nested_scroll";
      if (list) nodes.push(this.node("list", "", { className: "androidx.recyclerview.widget.RecyclerView", scrollable: true, contentDescription: "目标列表", bounds: [0, 90, 400, 700] }));
      if (s.mechanism === "nested_scroll") {
        nodes.find(n => n.key === "list")!.parent = "outer";
        nodes.splice(2, 0, this.node("outer", "", { scrollable: true, contentDescription: "外层列表", bounds: [0, 80, 400, 740] }));
      }
      const visible = s.mechanism !== "nested_scroll" || b.scrollOffset >= s.parameters.scrolls;
      if (visible) {
        const target = this.node("target", s.mechanism === "duplicate_labels" ? "打开项目" : s.target, { parent: list ? "list" : "root", clickable: true, contentDescription: s.target, bounds: [x, y, x + 280, y + 100] });
        const decoy = this.node("decoy", s.mechanism === "duplicate_labels" ? "打开项目" : "其他项目", { parent: list ? "list" : "root", clickable: true, contentDescription: "其他项目", bounds: [x, 400, x + 280, 500] });
        nodes.push(...(s.parameters.reverseOrder ? [decoy, target] : [target, decoy]));
        if (s.mechanism === "clickable_parent") {
          target.text = ""; target.contentDescription = "";
          nodes.push(this.node("target-label", s.target, { parent: "target", bounds: [x + 8, y + 8, x + 250, y + 70] }));
        }
        if (s.mechanism === "overlap") nodes.push(this.node("overlay", "帮助", { clickable: true, bounds: [x + 80, y + 10, x + 200, y + 90] }));
        if (s.mechanism === "unrelated_updates") nodes.push(this.node("ticker", `更新 ${this.reads}`, { parent: "decoy", bounds: [x + 10, 410, x + 200, 460] }));
      }
    }
    if (b.page === "list" && s.parameters.contextRefresh === "peer_item") {
      // Exercise the existing narrow whole-item exception: the target and
      // another named row share one native collection; only a peer leaf changes.
      const list = this.node("peer-list", "", { className: "androidx.recyclerview.widget.RecyclerView", scrollable: true, bounds: [0, 90, 400, 700] });
      nodes.find(node => node.key === "target")!.parent = "peer-list";
      nodes.find(node => node.key === "decoy")!.parent = "peer-list";
      nodes.push(list, this.node("ticker", `合成计数 ${rev}`, { parent: "decoy", bounds: [x + 10, 410, x + 200, 460] }));
    }
    if (b.page === "list" && s.parameters.contextRefresh === "cross_collection_context") {
      // Geometric separation does not prove business independence: the stable
      // current-account row belongs to another collection but governs this page.
      const left = this.node("left-list", "", { className: "androidx.recyclerview.widget.RecyclerView", scrollable: true, bounds: [0, 90, 190, 700] });
      const right = this.node("right-list", "", { className: "androidx.recyclerview.widget.RecyclerView", scrollable: true, bounds: [210, 90, 400, 700] });
      const target = nodes.find(node => node.key === "target")!;
      target.parent = "left-list"; target.bounds = [10, 120, 180, 220];
      const peer = nodes.find(node => node.key === "decoy")!;
      peer.parent = "right-list"; peer.bounds = [220, 120, 390, 220]; peer.text = "当前账号";
      const otherPeer = this.node("peer-two", "另一个合成条目", { parent: "right-list", clickable: true, bounds: [220, 300, 390, 400] });
      nodes.push(left, right, otherPeer, this.node("ticker", `合成账号 ${rev}`, { parent: "decoy", bounds: [230, 145, 380, 180] }));
      if (this.reads >= 2) b.contextChanged = true;
    }
    if (b.page !== "detail" && s.parameters.contextRefresh === "page_context") {
      nodes.find(node => node.key === "title")!.text = `合成工作台 ${rev}`;
      if (this.reads >= 2) b.contextChanged = true;
    }
    const session = b.sessionChanged ? "replacement" : "fixture";
    this.latest = { executor: "node-v1", snapshotId: `${session}:${rev}`, revision: rev, packageName: "synthetic.eval", windowId: 7, truncated: false,
      nodes: nodes.map(({ key, parent, ...node }) => ({ ...node, nodeId: `${key}-${rev}`, parentId: parent === null ? null : `${parent}-${rev}` })) };
    this.snapshots.set(this.latest.snapshotId, this.latest);
    while (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
    return this.latest;
  }
  private refusal(code: string, reason?: string): BridgeResponse {
    return { id: "eval", ok: false, error: phoneErrorSchema.parse({ code, message: "Synthetic native executor refused before dispatch", retryable: true,
      details: { executor: "node-v1", dispatchState: "not_sent", ...(reason ? { reason } : {}) } }),
      ...(this.latest ? { observation: this.latest } : {}), meta: { durationMs: 1 } };
  }
  private businessKey(nodeId: string): string { return nodeId.replace(/-\d+$/, ""); }
  private activate(key: string) {
    const b = this.state, s = this.scenario;
    b.mutations++;
    if (key === "editor") { b.focused = true; return; }
    if (key === "target" || key === "target-label" || key === "continue" && b.enteredText === s.input) {
      if (s.mechanism === "slow_loading") { b.page = "loading"; this.loadingTicks = s.parameters.loadingTicks; }
      else { b.page = "detail"; b.openedProject = s.target; }
    } else { b.wrongActions++; b.page = "detail"; b.openedProject = "其他项目"; }
  }
  async call(method: string, args: Json = {}, _timeout?: number, beforeDispatch?: () => void): Promise<BridgeResponse> {
    beforeDispatch?.(); this.calls.push({ method, ...(typeof args.action === "string" ? { action: args.action } : {}) });
    const b = this.state, s = this.scenario;
    if (method === "get_ui_tree") {
      this.reads++;
      if (b.protected) return fail("PROTECTED_APP");
      if (s.mechanism === "session_change" && this.reads === 2) b.sessionChanged = true;
      this.progressLoading(); return ok(this.snapshot());
    }
    if (method === "wait_for_ui_change") { this.progressLoading(); return ok({ changed: true, revision: this.revision + 1 }); }
    if (method === "get_current_app") return ok({ packageName: "synthetic.eval", windowId: 7 });
    if (method !== "act_and_observe") return fail("NOT_IMPLEMENTED");
    if (b.protected) return fail("PROTECTED_APP");
    if (b.cancelled) return fail("CANCELLED");
    let a = args.arguments as Json;
    // Reference implementation of the native contract for model-policy evals.
    // This is not Android validation; native-executor-eval exercises the real APK.
    if (["tap_element", "click_element", "input_text", "scroll"].includes(args.action)) {
      const previous = this.snapshots.get(a.snapshotId);
      this.reads++;
      if (s.mechanism === "session_change" && this.reads >= 2) b.sessionChanged = true;
      const fresh = this.snapshot();
      if (!previous) return this.refusal("STALE_SNAPSHOT", "SNAPSHOT_MISSING");
      try {
        const reference = prepareTargetRefresh(previous, a, args.action as NodeAction);
        if (!reference) return this.refusal("NODE_NOT_ACTIONABLE", "NO_CLICKABLE_TARGET");
        a = rebindRefreshedTarget(reference, fresh, a);
      } catch (error) {
        if (error instanceof AgentError) return this.refusal(error.code, error.details?.reason as string | undefined);
        throw error;
      }
    }
    if (s.mechanism === "target_move" && s.seed % 2 === 1 && !this.movedDuringDispatch) {
      // A final native refresh detects movement before any mutation is sent.
      this.movedDuringDispatch = true; return this.refusal("STALE_SNAPSHOT", "NODE_BOUNDS_CHANGED");
    }
    if (args.action !== "press_key" && args.action !== "open_settings" && a.snapshotId !== this.latest?.snapshotId) return fail("STALE_SNAPSHOT");
    const nodes: Json[] = this.latest?.nodes ?? [];
    const node = nodes.find(n => n.nodeId === a.nodeId);
    if (["tap_element", "click_element"].includes(args.action)) {
      let actual = node;
      for (let hops = 0; actual && !actual.clickable && hops < 8; hops++) actual = nodes.find(n => n.nodeId === actual!.parentId);
      if (!actual?.clickable) return this.refusal("NODE_NOT_ACTIONABLE", "NO_CLICKABLE_TARGET");
      const geometry = touchGeometry(nodes);
      const region = node && geometry.region(node);
      const blockers = nodes.filter(n => n !== actual && !geometry.descendsFrom(actual!, n) && n.visible !== false &&
        (n.clickable || !geometry.descendsFrom(n, actual!) && (n.text || n.contentDescription || n.editable || n.password)));
      if (!region || !unobstructedTouchPoint(region, blockers.map(n => geometry.region(n)).filter((b): b is TouchRect => !!b))) return this.refusal("NODE_NOT_ACTIONABLE", "AMBIGUOUS_TOUCH_TARGET");
    }
    b.dispatches++;
    if (args.action === "input_text") {
      if (!node?.editable) return fail("NOT_EDITABLE");
      b.mutations++; b.enteredText = a.text; b.focused = true;
      if (a.text !== s.input) b.wrongActions++;
    } else if (args.action === "scroll") {
      if (!node?.scrollable) return fail("NOT_SCROLLABLE");
      b.mutations++;
      if (this.businessKey(node.nodeId) === "list" && ["forward", "down"].includes(a.direction)) b.scrollOffset++;
      else b.wrongActions++;
    } else if (args.action === "click_element" || args.action === "tap_element") {
      let actual = node;
      while (actual && !actual.clickable) {
        const parentId = actual.parentId;
        actual = nodes.find(n => n.nodeId === parentId);
      }
      if (!actual) return fail("NODE_NOT_ACTIONABLE");
      this.activate(this.businessKey(actual.nodeId));
    } else if (args.action === "swipe") {
      if (Math.hypot(a.endX - a.startX, a.endY - a.startY) < 24) {
        const hit = nodes.filter(n => n.clickable && inside(n, a.startX, a.startY)).at(-1);
        if (!hit) return fail("NODE_NOT_ACTIONABLE");
        this.activate(this.businessKey(hit.nodeId));
      } else {
        b.mutations++;
        if (nodes.some(n => n.scrollable && this.businessKey(n.nodeId) === "list" && inside(n, a.startX, a.startY)) && a.endY < a.startY) b.scrollOffset++;
        else b.wrongActions++;
      }
    } else if (args.action === "press_key" && a.key === "back" && b.focused) { b.focused = false; b.mutations++; }
    else { b.mutations++; b.wrongActions++; }
    if (s.mechanism === "lost_response" && b.openedProject === s.target && !b.responseLost) { b.responseLost = true; return fail("BRIDGE_CLOSED"); }
    return ok({ action: { executor: "node-v1", dispatchState: "sent", accepted: true, action: args.action, revision: this.revision + 1,
      ...(["swipe", "tap_element"].includes(args.action) ? { completion: "completed" } : {}) }, observation: this.snapshot() });
  }
}
