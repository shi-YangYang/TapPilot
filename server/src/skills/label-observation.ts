import { isDeepStrictEqual } from "node:util";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const flags = ["clickable", "scrollable", "editable", "enabled", "password", "checkable", "checked", "selected", "focused", "visible"];
const interactive = (node: Json): boolean => ["clickable", "scrollable", "editable", "checkable", "checked", "selected", "focused", "longClickable"].some(key => node[key] === true);
const rectangle = (value: unknown): value is number[] => Array.isArray(value) && value.length === 4
  && value.every(coordinate => Number.isSafeInteger(coordinate)) && value[0] < value[2] && value[1] < value[3];
function session(value: Json): string | undefined {
  if (typeof value.snapshotId !== "string") return;
  const separator = value.snapshotId.lastIndexOf(":");
  if (separator < 1 || separator === value.snapshotId.length - 1) return;
  const extracted = value.snapshotId.slice(0, separator);
  return value.sessionId === undefined || value.sessionId === extracted ? extracted : undefined;
}
function nodes(value: Json): Json[] | undefined {
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 500) return;
  const seen = new Set<string>();
  const result: Json[] = [];
  for (const [index, input] of value.nodes.entries()) {
    if (!object(input)) return;
    // createPhoneClient.compactUi omits empty strings/null and false capability
    // flags. Visibility/enabled and supplied checked/selected/focused states
    // are retained: their absence is unknown and cannot become true here.
    const node: Json = { ...input };
    for (const key of ["text", "contentDescription", "resourceId"]) if (node[key] === undefined) node[key] = "";
    for (const key of ["clickable", "scrollable", "editable", "password", "checkable"]) if (node[key] === undefined) node[key] = false;
    if (index === 0 && node.parentId === undefined) node.parentId = null;
    if (typeof node.nodeId !== "string" || !node.nodeId || seen.has(node.nodeId)
      || typeof node.className !== "string" || !node.className || typeof node.resourceId !== "string"
      || typeof node.text !== "string" || typeof node.contentDescription !== "string" || !rectangle(node.bounds)
      || flags.some(key => typeof node[key] !== "boolean")
      || (index === 0 ? node.parentId !== null : typeof node.parentId !== "string" || !seen.has(node.parentId))) return;
    seen.add(node.nodeId);
    result.push(node);
  }
  return result;
}

/** Physical differences between two fresh complete observations, not a native
 * rejection and not permission to ignore text. Recipient/amount labels can be
 * returned too: only the task model can assess their meaning, and every action
 * must still pass the phone's current target/context guards. No UI is retained. */
export function observedLabelChanges(before: unknown, after: unknown): string[] | undefined {
  if (!object(before) || !object(after) || before.truncated !== false || after.truncated !== false
    || typeof before.packageName !== "string" || !before.packageName || before.packageName !== after.packageName
    || !Number.isSafeInteger(before.windowId) || before.windowId !== after.windowId
    || !session(before) || session(before) !== session(after) || before.snapshotId === after.snapshotId) return;
  if (before.revision !== undefined || after.revision !== undefined) {
    if (!Number.isSafeInteger(before.revision) || !Number.isSafeInteger(after.revision)
      || Number(after.revision) < Number(before.revision)) return;
  }
  const oldNodes = nodes(before), newNodes = nodes(after);
  if (!oldNodes || !newNodes || oldNodes.length !== newNodes.length) return;
  const byId = new Map(newNodes.map(node => [String(node.nodeId), node]));
  const parents = new Set(newNodes.map(node => node.parentId));
  const changed: string[] = [];
  for (const [index, oldNode] of oldNodes.entries()) {
    const node = newNodes[index]!;
    const withoutText = (entry: Json) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "text" && key !== "contentDescription"));
    // Covers IDs, ordered hierarchy, optional native paths, bounds, role,
    // capabilities and any future metadata; unknown differences fail closed.
    if (!isDeepStrictEqual(withoutText(oldNode), withoutText(node))) return;
    if (oldNode.text === node.text && oldNode.contentDescription === node.contentDescription) continue;
    if (interactive(node) || node.password !== false || node.visible !== true || node.enabled !== true
      || node.contextProtected === true || node.heading === true || node.labelFor != null || node.labeledBy != null
      || parents.has(node.nodeId)) return;
    let parent = byId.get(String(node.parentId));
    while (parent) {
      if (["clickable", "editable", "password", "checkable", "longClickable"].some(key => parent![key] === true)
        || parent.visible !== true || parent.enabled !== true || parent.contextProtected === true) return;
      parent = byId.get(String(parent.parentId));
    }
    changed.push(String(node.nodeId));
    if (changed.length > 8) return;
  }
  return changed.length ? changed : undefined;
}
