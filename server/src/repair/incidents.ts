import { IncidentSchema, type RepairIncident } from "./schema.js";
import type { FailureSummary } from "../diagnostics/schema.js";
import type { Mechanism } from "../eval/scenarios.js";

/** These links choose experiments, not a diagnosis. The pipeline must reproduce
 * a failure before considering any proposed helper replacement a repair. */
export function selectRepairIncidents(groups: readonly FailureSummary[]): RepairIncident[] {
  return groups.flatMap(group => {
    let mechanism: Mechanism | undefined;
    if (group.errorCode === "STALE_SNAPSHOT") mechanism = "fresh_ids";
    if (group.errorCode === "TARGET_CHANGED") mechanism = "unrelated_updates";
    if (group.errorCode === "NODE_NOT_ACTIONABLE") mechanism = group.reason === "AMBIGUOUS_TOUCH_TARGET" ? "overlap" : "clickable_parent";
    if (!mechanism) return [];
    const parsed = IncidentSchema.safeParse({ schemaVersion: 1, actionKind: group.actionKind, errorCode: group.errorCode, reason: group.reason,
      count: group.count, mechanism, scenarioId: `${mechanism}-1` });
    return parsed.success ? [parsed.data] : [];
  }).sort((a, b) => b.count - a.count).slice(0, 20);
}
