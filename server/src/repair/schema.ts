import { createHash } from "node:crypto";
import { z } from "zod";
import { DiagnosticErrorCodeSchema, DiagnosticReasonSchema, ActionKindSchema } from "../diagnostics/schema.js";
import { MECHANISMS } from "../eval/scenarios.js";

export const REPAIR_PATH = "server/src/runtime/ui-projection.ts";
export const HELPERS = ["bounds", "meaningful", "projectNode", "projectNodes"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const IncidentSchema = z.object({
  schemaVersion: z.literal(1), actionKind: ActionKindSchema, errorCode: DiagnosticErrorCodeSchema,
  reason: DiagnosticReasonSchema, count: z.number().int().min(1).max(1_000_000),
  mechanism: z.enum(MECHANISMS), scenarioId: z.string().regex(/^[a-z_]+-[1-9]\d?$/),
}).strict();
export type RepairIncident = z.infer<typeof IncidentSchema>;
export const RepairCandidateSchema = z.object({
  schemaVersion: z.literal(1), baselineSha: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.literal(REPAIR_PATH), sourceHash: hash,
  replacements: z.array(z.object({ helper: z.enum(HELPERS), originalHash: hash, content: z.string().min(1).max(16_384) }).strict()).min(1).max(4),
}).strict();
export type RepairCandidate = z.infer<typeof RepairCandidateSchema>;
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export class RepairError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RepairError"; }
}
export const repairCode = (error: unknown): string => error instanceof RepairError ? error.code : "REPAIR_FAILED";
