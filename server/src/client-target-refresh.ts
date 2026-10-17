import { AgentError } from "./errors.js";

type Json = Record<string, unknown>;
export type NodeAction = "tap_element" | "click_element" | "input_text" | "scroll";
type Tree = { snapshot: Json; nodes: Json[]; byId: Map<string, Json>; children: Map<string, Json[]> };
export type TargetRefresh = { tree: Tree; action: NodeAction; signature: string; own: string; context: string; nodeId: string };
/** Structural diagnostics only: never persist labels, IDs, positions or their hashes. */
export type ContextChangeEvidence = {
  region: "target" | "ancestor" | "target_descendant" | "peer_item" | "outside_target" | "mixed" | "unknown";
  kind: "content" | "state" | "structure" | "geometry" | "mixed" | "unknown";
  changedNodes: number;
  targetMatched: boolean;
  actionTargetMatched: boolean;
};
const semanticStrings = { text: 1000, contentDescription: 1000, resourceId: 512, className: 512 };
const collectionClasses = new Set(["androidx.recyclerview.widget.RecyclerView", "android.support.v7.widget.RecyclerView", "android.widget.ListView", "android.widget.GridView"]);
type ChangeReason = "TREE_INCOMPLETE" | "SESSION_CHANGED" | "WINDOW_CHANGED" | "TARGET_IDENTITY_CHANGED" | "TARGET_AMBIGUOUS" | "PAGE_CONTEXT_CHANGED";

function changed(reason: ChangeReason, contextChange?: ContextChangeEvidence): AgentError {
  return new AgentError("TARGET_CHANGED", "The intended control cannot be uniquely verified in the refreshed UI. No action was sent; choose a target from the returned observation.", true, { reason, ...(contextChange ? { contextChange } : {}) });
}

/** Parse only complete native trees; never infer missing ancestors from a find result. */
function fullTree(value: unknown): Tree | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const snapshot = value as Json;
  if (snapshot.truncated !== false || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length || snapshot.nodes.length > 500 ||
      typeof snapshot.snapshotId !== "string" || !/^.+:\d+$/.test(snapshot.snapshotId) ||
      typeof snapshot.packageName !== "string" || !snapshot.packageName || snapshot.packageName.length >= 512 ||
      !Number.isSafeInteger(snapshot.windowId) || !Number.isSafeInteger(snapshot.revision)) return;
  const nodes = snapshot.nodes as Json[];
  const byId = new Map<string, Json>();
  const children = new Map<string, Json[]>();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.nodeId !== "string" || !node.nodeId || byId.has(node.nodeId) ||
        (node.parentId !== null && typeof node.parentId !== "string")) return;
    byId.set(node.nodeId, node);
  }
  if (nodes.filter((node) => node.parentId === null).length !== 1) return;
  for (const node of nodes) {
    if (node.parentId !== null) {
      if (!byId.has(String(node.parentId))) return;
      const siblings = children.get(String(node.parentId)) ?? [];
      siblings.push(node);
      children.set(String(node.parentId), siblings);
    }
    const visited = new Set<string>();
    let current: Json | undefined = node;
    while (current) {
      if (visited.has(String(current.nodeId))) return;
      visited.add(String(current.nodeId));
      current = current.parentId === null ? undefined : byId.get(String(current.parentId));
    }
  }
  return { snapshot, nodes, byId, children };
}

/** Safe to provide as new evidence even when the selected target no longer matches. */
export function completeRefreshObservation(value: unknown): Json | undefined {
  return fullTree(value)?.snapshot;
}

function ownSemantic(node: Json): string | undefined {
  const fields: Json = {};
  for (const [key, limit] of Object.entries(semanticStrings)) {
    const value = node[key];
    // Android caps these fields. Equality at the cap could be equality of prefixes only.
    if (typeof value !== "string" || value.length >= limit) return;
    fields[key] = value;
  }
  // Older APKs omit state fields. Keep those observations on the original Android-
  // validated path instead of treating unknown toggle/selection state as false.
  for (const field of ["clickable", "scrollable", "editable", "enabled", "password", "checkable", "checked", "selected", "focused"]) {
    if (typeof node[field] !== "boolean") return;
    fields[field] = node[field];
  }
  fields.visible = node.visible !== false;
  return JSON.stringify(fields);
}

function pageContext(tree: Tree, independentItems = new Map<string, string>()): string | undefined {
  function visit(node: Json): unknown[] | undefined {
    const item = independentItems.get(String(node.nodeId));
    if (item !== undefined) return [["independent-list-item", item]];
    const own = ownSemantic(node);
    if (!own) return;
    const children: unknown[] = [];
    for (const child of tree.children.get(String(node.nodeId)) ?? []) {
      const branch = visit(child);
      if (!branch) return;
      children.push(...branch);
    }
    const meaningful = node.text !== "" || node.contentDescription !== "" ||
      ["clickable", "scrollable", "editable", "password", "checkable", "checked", "selected", "focused"].some((key) => node[key] === true) ||
      node.enabled === false || node.visible === false;
    // Empty layout wrappers have no semantic role here. Preserve meaningful order
    // and hierarchy, including titles outside the target's own ancestor/subtree.
    return meaningful ? [[own, children]] : children;
  }
  const root = tree.nodes.find((node) => node.parentId === null)!;
  const context = visit(root);
  return context ? JSON.stringify(context) : undefined;
}

type Rect = [number, number, number, number];
function bounds(node: Json): Rect | undefined {
  const value = node.bounds;
  if (!Array.isArray(value) || value.length !== 4 || !value.every((part) => typeof part === "number" && Number.isFinite(part)) ||
      value[0] >= value[2] || value[1] >= value[3]) return;
  return value as Rect;
}

function listItem(tree: Tree, selected: Json): { item: Json; list: Json } | undefined {
  let item = selected;
  while (typeof item.parentId === "string") {
    const parent = tree.byId.get(item.parentId)!;
    if (parent.scrollable === true) return { item, list: parent };
    item = parent;
  }
}

function itemIdentity(node: Json): string | undefined {
  // A resource ID alone often names every recycled row. Require the item's own
  // label as well; a title found only on a descendant cannot identify its group.
  if (node.clickable !== true || typeof node.className !== "string" || !node.className ||
      typeof node.text !== "string" || typeof node.contentDescription !== "string" ||
      (!node.text.trim() && !node.contentDescription.trim())) return;
  return ownSemantic(node);
}

function independentItemContext(tree: Tree, item: Json): string | undefined {
  const region = bounds(item);
  if (!region || item.enabled !== true || item.visible === false || item.password === true) return;
  function visit(node: Json, insideControl: boolean, visible: boolean): unknown[] | undefined {
    const own = ownSemantic(node), rect = bounds(node);
    if (!own || !rect || rect[0] < region![0] || rect[1] < region![1] || rect[2] > region![2] || rect[3] > region![3]) return;
    const control = node !== item && ["clickable", "scrollable", "editable", "checkable", "password"].some((key) => node[key] === true);
    const protectedControl = insideControl || control;
    const visibleBranch = visible && node.enabled === true && node.visible !== false && node.password !== true;
    const children = tree.children.get(String(node.nodeId)) ?? [];
    // Keep every node and its order, including empty layout wrappers. Only an
    // existing visible leaf label outside nested controls may vary. The item's
    // own stable identity and all labels of its buttons/inputs remain exact.
    if (node !== item && !children.length && visibleBranch && !protectedControl &&
        !["checked", "selected", "focused"].some((key) => node[key] === true)) {
      return ["label", ownSemantic({ ...node, text: "", contentDescription: "" }), node.text !== "", node.contentDescription !== ""];
    }
    const content: unknown[] = [];
    for (const child of children) {
      const branch = visit(child, protectedControl, visibleBranch);
      if (!branch) return;
      content.push(branch);
    }
    return ["node", own, content];
  }
  const context = visit(item, false, true);
  return context ? JSON.stringify(context) : undefined;
}

function actualClickTarget(tree: Tree, target: Json): Json | undefined {
  let actual = target;
  for (let depth = 0; depth <= 8; depth++) {
    if (["editable", "checkable", "scrollable", "password"].some((key) => actual[key] === true)) return;
    if (actual.clickable === true) return actual;
    const parent = tree.byId.get(String(actual.parentId));
    if (!parent) return;
    actual = parent;
  }
}

function descendsFrom(tree: Tree, node: Json, ancestor: Json): boolean {
  let current: Json | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = tree.byId.get(String(current.parentId));
  }
  return false;
}

/** A narrow collection-item click exception, never a general form/field context heuristic. */
function sameContextWithIndependentItems(previous: Tree, fresh: Tree, selected: Json, refreshed: Json, action: NodeAction): boolean {
  if (action !== "tap_element" && action !== "click_element") return false;
  const before = listItem(previous, selected), after = listItem(fresh, refreshed);
  if (!before || !after || !collectionClasses.has(String(before.list.className)) || !collectionClasses.has(String(after.list.className))) return false;
  // Rebinding an embedded input or button could apply to a changed recipient or
  // form context elsewhere. Only a click whose actual destination is the entire
  // identified collection item may use this exception.
  if (actualClickTarget(previous, selected) !== before.item || actualClickTarget(fresh, refreshed) !== after.item) return false;
  const oldItems = previous.children.get(String(before.list.nodeId)) ?? [];
  const newItems = fresh.children.get(String(after.list.nodeId)) ?? [];
  if (oldItems.length < 2 || oldItems.length !== newItems.length) return false;
  const oldKeys = oldItems.map(itemIdentity), newKeys = newItems.map(itemIdentity);
  if (oldKeys.some((key) => key === undefined) || newKeys.some((key) => key === undefined) ||
      new Set(oldKeys).size !== oldKeys.length || new Set(newKeys).size !== newKeys.length ||
      oldKeys.some((key, index) => key !== newKeys[index])) return false;
  const targetIndex = oldItems.indexOf(before.item);
  if (targetIndex < 0 || newItems[targetIndex] !== after.item) return false;
  const oldTarget = bounds(before.item), newTarget = bounds(after.item);
  if (!oldTarget || !newTarget || !independentItemContext(previous, before.item) || !independentItemContext(fresh, after.item)) return false;
  const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const oldContexts = new Map<string, string>(), newContexts = new Map<string, string>();
  // This exception is confined to sibling items in the target's own collection.
  // Another collection may carry the current account/recipient even when its
  // identity and bounds are stable; native grouping cannot prove independence.
  for (let index = 0; index < oldItems.length; index++) {
    if (index === targetIndex) continue;
    const oldItem = oldItems[index]!, newItem = newItems[index]!;
    const oldBounds = bounds(oldItem), newBounds = bounds(newItem);
    if (!oldBounds || !newBounds || [oldBounds, newBounds].some((rect) => overlaps(rect, oldTarget) || overlaps(rect, newTarget))) continue;
    const oldContext = independentItemContext(previous, oldItem), newContext = independentItemContext(fresh, newItem);
    if (!oldContext || oldContext !== newContext) continue;
    oldContexts.set(String(oldItem.nodeId), oldContext);
    newContexts.set(String(newItem.nodeId), newContext!);
  }
  return oldContexts.size > 0 && pageContext(previous, oldContexts) === pageContext(fresh, newContexts);
}

function contextChangeEvidence(previous: Tree, fresh: Tree, selected: Json, refreshed: Json): ContextChangeEvidence {
  const result: ContextChangeEvidence = { region: "unknown", kind: "unknown", changedNodes: 0, targetMatched: true, actionTargetMatched: true };
  const oldRoot = previous.nodes.find((node) => node.parentId === null)!;
  const newRoot = fresh.nodes.find((node) => node.parentId === null)!;
  const pairs: [Json, Json][] = [];
  function align(old: Json, current: Json): boolean {
    // Positional comparison is evidence only when the native structure/roles
    // agree. An inserted/replaced branch cannot honestly identify which text
    // changed, and a resource ID is never itself retained in this diagnostic.
    const oldChildren = previous.children.get(String(old.nodeId)) ?? [];
    const newChildren = fresh.children.get(String(current.nodeId)) ?? [];
    if (old.className !== current.className || old.resourceId !== current.resourceId || oldChildren.length !== newChildren.length) return false;
    pairs.push([old, current]);
    return oldChildren.every((child, index) => align(child, newChildren[index]!));
  }
  if (!align(oldRoot, newRoot) || !pairs.some(([old, current]) => old === selected && current === refreshed)) {
    return { ...result, kind: "structure" };
  }
  const actual = actualClickTarget(previous, selected) ?? selected;
  const targetItem = listItem(previous, selected);
  const regions = new Set<ContextChangeEvidence["region"]>();
  const kinds = new Set<ContextChangeEvidence["kind"]>();
  for (const [old, current] of pairs) {
    const nodeKinds = new Set<ContextChangeEvidence["kind"]>();
    if (old.text !== current.text || old.contentDescription !== current.contentDescription) nodeKinds.add("content");
    for (const key of ["clickable", "scrollable", "editable", "enabled", "password", "checkable", "checked", "selected", "focused", "visible"]) {
      if (old[key] !== current[key]) nodeKinds.add("state");
    }
    if (JSON.stringify(old.bounds) !== JSON.stringify(current.bounds)) nodeKinds.add("geometry");
    if (!nodeKinds.size) continue;
    result.changedNodes++;
    for (const kind of nodeKinds) kinds.add(kind);
    if (old === selected) regions.add("target");
    else if (descendsFrom(previous, selected, old)) regions.add("ancestor");
    else if (descendsFrom(previous, old, actual)) regions.add("target_descendant");
    else {
      const item = listItem(previous, old);
      regions.add(targetItem && item?.list === targetItem.list && item.item !== targetItem.item ? "peer_item" : "outside_target");
    }
  }
  result.region = regions.size > 1 ? "mixed" : regions.values().next().value ?? "unknown";
  result.kind = kinds.size > 1 ? "mixed" : kinds.values().next().value ?? "unknown";
  return result;
}

function targetSignature(tree: Tree, requested: Json, action: NodeAction): string | undefined {
  if (requested.enabled !== true || requested.visible === false || requested.password === true) return;
  if (action === "input_text" && requested.editable !== true) return;
  if (action === "scroll" && requested.scrollable !== true) return;
  let actual = requested;
  if (action === "tap_element" || action === "click_element") {
    for (let depth = 0; actual.clickable !== true && depth < 8; depth++) {
      const parent = tree.byId.get(String(actual.parentId));
      if (!parent) return;
      actual = parent;
    }
    if (actual.clickable !== true || actual.enabled !== true || actual.visible === false || actual.password === true) return;
  }
  const ancestors: string[] = [];
  let node: Json | undefined = requested;
  while (node) {
    const semantic = ownSemantic(node);
    if (!semantic || node.visible === false || node.password === true) return;
    ancestors.push(semantic);
    node = tree.byId.get(String(node.parentId));
  }
  function subtree(node: Json): unknown[] | undefined {
    const own = ownSemantic(node);
    if (!own) return;
    const children: unknown[] = [];
    for (const child of tree.children.get(String(node.nodeId)) ?? []) {
      const branch = subtree(child);
      if (!branch) return;
      children.push(branch);
    }
    return [own, children];
  }
  // All labels inside a clicked container matter. Scroll also retains its full subtree:
  // a changed list is new evidence for the model, not permission to scroll a replacement.
  const content = subtree(actual);
  const selectedContent = subtree(requested);
  if (!content || !selectedContent) return;
  return JSON.stringify([ancestors, content, selectedContent]);
}

/** Unprovable identities retain the existing Android-validated path; do not broaden permission. */
export function prepareTargetRefresh(value: unknown, target: Json, action: NodeAction): TargetRefresh | undefined {
  const tree = fullTree(value);
  if (!tree || tree.snapshot.snapshotId !== target.snapshotId) return;
  const selected = tree.byId.get(String(target.nodeId));
  if (!selected) return;
  const own = ownSemantic(selected);
  const signature = targetSignature(tree, selected, action);
  const context = pageContext(tree);
  if (!own || !signature || !context) return;
  const candidates = tree.nodes.filter((node) => ownSemantic(node) === own && targetSignature(tree, node, action) === signature);
  if (candidates.length !== 1) return;
  return { tree, action, own, signature, context, nodeId: String(selected.nodeId) };
}

export function rebindRefreshedTarget(reference: TargetRefresh, value: unknown, original: Json, onContextChange?: (evidence: ContextChangeEvidence) => void): Json {
  const fresh = fullTree(value);
  if (!fresh) throw changed("TREE_INCOMPLETE");
  const previous = reference.tree.snapshot;
  const session = (snapshot: Json) => String(snapshot.snapshotId).slice(0, String(snapshot.snapshotId).lastIndexOf(":"));
  if (session(previous) !== session(fresh.snapshot) || Number(fresh.snapshot.revision) < Number(previous.revision)) throw changed("SESSION_CHANGED");
  if (previous.windowId !== fresh.snapshot.windowId || previous.packageName !== fresh.snapshot.packageName) throw changed("WINDOW_CHANGED");
  const context = pageContext(fresh);
  if (!context) throw changed("TREE_INCOMPLETE");
  const candidates = fresh.nodes.filter((node) => ownSemantic(node) === reference.own && targetSignature(fresh, node, reference.action) === reference.signature);
  if (!candidates.length) throw changed("TARGET_IDENTITY_CHANGED");
  if (candidates.length !== 1) throw changed("TARGET_AMBIGUOUS");
  if (context !== reference.context) {
    const selected = reference.tree.byId.get(reference.nodeId)!, refreshed = candidates[0]!;
    const evidence = contextChangeEvidence(reference.tree, fresh, selected, refreshed);
    onContextChange?.(evidence);
    if (!sameContextWithIndependentItems(reference.tree, fresh, selected, refreshed, reference.action)) throw changed("PAGE_CONTEXT_CHANGED", evidence);
  }
  return { ...original, snapshotId: fresh.snapshot.snapshotId, nodeId: candidates[0]!.nodeId };
}
