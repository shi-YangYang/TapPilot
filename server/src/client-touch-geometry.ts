import { AgentError } from "./errors.js";

type Json = Record<string, unknown>;
export type TouchRect = [number, number, number, number];

function invalid(reason: "INVALID_HIERARCHY" | "INVALID_BOUNDS", message: string): never {
  throw new AgentError("NODE_NOT_ACTIONABLE", `${message} No touch was sent.`, false, { reason });
}
export function intersectTouchRects(a: TouchRect, b: TouchRect): TouchRect | undefined {
  const region: TouchRect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return region[0] < region[2] && region[1] < region[3] ? region : undefined;
}

/** Competitors use their own screen bounds: the tree does not expose clipChildren. */
export function touchGeometry(nodes: Json[]) {
  const byId = new Map<string, Json>();
  for (const node of nodes) {
    if (typeof node.nodeId !== "string" || !node.nodeId || byId.has(node.nodeId) ||
        (node.parentId !== null && typeof node.parentId !== "string")) {
      invalid("INVALID_HIERARCHY", "The UI contains invalid or duplicate node identities.");
    }
    byId.set(node.nodeId, node);
  }
  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) invalid("INVALID_HIERARCHY", "The UI does not contain exactly one observed root.");
  const root = roots[0]!;
  const ancestry = new Map<Json, Set<Json>>();
  const regions = new Map<Json, TouchRect | undefined>();
  for (const node of nodes) {
    const chain = new Set<Json>();
    let current = node;
    while (true) {
      if (chain.has(current)) invalid("INVALID_HIERARCHY", "The UI contains a cyclic parent chain.");
      chain.add(current);
      if (current === root) break;
      const parent = byId.get(String(current.parentId));
      if (!parent) invalid("INVALID_HIERARCHY", "The UI contains a missing observed ancestor.");
      current = parent;
    }
    ancestry.set(node, chain);
    if (node.visible === false) {
      regions.set(node, undefined);
      continue;
    }
    const bounds = node.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((value) => typeof value === "number" && Number.isFinite(value))) {
      invalid("INVALID_BOUNDS", "A visible node has invalid observed bounds.");
    }
    // A visible child can extend beyond a parent's bounds. Even a hidden parent
    // does not erase conflicting evidence from an explicitly visible child.
    regions.set(node, intersectTouchRects([0, 0, 16385, 16385], bounds as TouchRect));
  }
  return {
    region: (node: Json) => regions.get(node),
    descendsFrom: (node: Json, ancestor: Json) => node !== ancestor && ancestry.get(node)?.has(ancestor) === true,
    hasHiddenAncestor: (node: Json) => [...(ancestry.get(node) ?? [])].some((ancestor) => ancestor !== node && ancestor.visible === false),
    contains: (node: Json, x: number, y: number) => {
      const region = regions.get(node);
      return !!region && x >= region[0] && x < region[2] && y >= region[1] && y < region[3];
    },
  };
}

/** Subtract observed blockers; choose one interior point, never probe the phone. */
export function unobstructedTouchPoint(region: TouchRect, blockers: TouchRect[]): { x: number; y: number } | undefined {
  let remaining = [region];
  for (const blocker of blockers) {
    const next: TouchRect[] = [];
    for (const area of remaining) {
      const overlap = intersectTouchRects(area, blocker);
      if (!overlap) { next.push(area); continue; }
      const candidates: TouchRect[] = [
        [area[0], area[1], area[2], overlap[1]],
        [area[0], overlap[3], area[2], area[3]],
        [area[0], overlap[1], overlap[0], overlap[3]],
        [overlap[2], overlap[1], area[2], overlap[3]],
      ];
      next.push(...candidates.filter((part) => part[0] < part[2] && part[1] < part[3]));
    }
    // A highly fragmented tree is insufficient evidence for a precise touch.
    if (!next.length || next.length > 4096) return;
    remaining = next;
  }
  const center = { x: (region[0] + region[2]) / 2, y: (region[1] + region[3]) / 2 };
  const candidates = remaining.map((area) => {
    const x = Math.floor((area[0] + area[2]) / 2), y = Math.floor((area[1] + area[3]) / 2);
    const clearance = Math.min(x - area[0], y - area[1], area[2] - x, area[3] - y);
    return { x, y, clearance, area: (area[2] - area[0]) * (area[3] - area[1]), distance: Math.hypot(x - center.x, y - center.y) };
  }).filter((candidate) => candidate.clearance >= 4);
  candidates.sort((a, b) => b.clearance - a.clearance || b.area - a.area || a.distance - b.distance || a.y - b.y || a.x - b.x);
  const point = candidates[0];
  return point ? { x: point.x, y: point.y } : undefined;
}
