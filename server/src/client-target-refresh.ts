import { AgentError } from "./errors.js";

type Json = Record<string, unknown>;
export type NodeAction = "tap_element" | "click_element" | "input_text" | "scroll";
type Tree = { snapshot: Json; nodes: Json[]; byId: Map<string, Json>; children: Map<string, Json[]> };
export type TargetRefresh = { tree: Tree; action: NodeAction; signature: string; own: string; context: string };
const semanticStrings = { text: 1000, contentDescription: 1000, resourceId: 512, className: 512 };

function changed(): AgentError {
  return new AgentError("TARGET_CHANGED", "The intended control cannot be uniquely verified in the refreshed UI. No action was sent; choose a target from the returned observation.", true);
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

function pageContext(tree: Tree): string | undefined {
  function visit(node: Json): unknown[] | undefined {
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
  return { tree, action, own, signature, context };
}

export function rebindRefreshedTarget(reference: TargetRefresh, value: unknown, original: Json): Json {
  const fresh = fullTree(value);
  if (!fresh) throw changed();
  const previous = reference.tree.snapshot;
  const session = (snapshot: Json) => String(snapshot.snapshotId).slice(0, String(snapshot.snapshotId).lastIndexOf(":"));
  if (session(previous) !== session(fresh.snapshot) || previous.windowId !== fresh.snapshot.windowId || previous.packageName !== fresh.snapshot.packageName ||
      Number(fresh.snapshot.revision) < Number(previous.revision)) throw changed();
  if (pageContext(fresh) !== reference.context) throw changed();
  const candidates = fresh.nodes.filter((node) => ownSemantic(node) === reference.own && targetSignature(fresh, node, reference.action) === reference.signature);
  if (candidates.length !== 1) throw changed();
  return { ...original, snapshotId: fresh.snapshot.snapshotId, nodeId: candidates[0]!.nodeId };
}
