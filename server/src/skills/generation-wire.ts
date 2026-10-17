import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PredicateSchema, SkillOperationSchema, SkillProcedureSchema, type ObservationFacts, type SkillFeedback, type SkillSpec } from "./schema.js";
import type { FailureEpisode } from "./trace.js";
import { SkillTrainingFeedbackSchema, type SkillTrainingFeedback } from "./training-feedback.js";

export const SkillProposalSchema = SkillProcedureSchema.extend({ prevention: SkillProcedureSchema.optional() });
const LinearProcedureSchema = z.object({
  entryConditions: z.array(PredicateSchema).max(6), steps: z.array(SkillOperationSchema).min(1).max(7), outcome: z.enum(["continue", "stop"]),
}).strict();
export const SkillLinearProposalSchema = LinearProcedureSchema.extend({ prevention: LinearProcedureSchema.optional() });
const ProcedureWireSchema = z.union([LinearProcedureSchema, SkillProcedureSchema]);
const ProposalWireSchema = z.union([
  LinearProcedureSchema.extend({ prevention: ProcedureWireSchema.optional() }),
  SkillProcedureSchema.extend({ prevention: ProcedureWireSchema.optional() }),
]);
const { $schema: _dialect, ...linearJsonSchema } = zodToJsonSchema(SkillLinearProposalSchema, { $refStrategy: "none" });
export const SKILL_LINEAR_PROPOSAL_JSON_SCHEMA = linearJsonSchema;

/** A short wire format removes graph bookkeeping from simple proposals. The
 * host only supplies sequential edges; every condition, operation and outcome
 * must still come from the model and pass the unchanged canonical schema. */
export function parseSkillProposal(input: unknown): z.SafeParseReturnType<unknown, z.infer<typeof SkillProposalSchema>> {
  const proposal = ProposalWireSchema.safeParse(input);
  if (!proposal.success) return SkillProposalSchema.safeParse(input);
  const canonical = (procedure: z.infer<typeof ProcedureWireSchema>) => "steps" in procedure ? {
    entryConditions: procedure.entryConditions, program: { entry: 0, nodes: [
      ...procedure.steps.map((operation, index) => ({ kind: "step", operation, next: index + 1 })),
      { kind: "end", outcome: procedure.outcome },
    ] },
  } : { entryConditions: procedure.entryConditions, program: procedure.program };
  return SkillProposalSchema.safeParse({ ...canonical(proposal.data),
    ...(proposal.data.prevention ? { prevention: canonical(proposal.data.prevention) } : {}) });
}

/** Some compatible models wrap otherwise valid JSON in a Markdown code fence.
 * Accept exactly one complete json fence, never extract from prose or a series
 * of objects. The decoded value still goes through the same strict schemas. */
export function decodeSkillProposalJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (!fenced) return JSON.parse(trimmed);
  if (fenced[1]!.includes("```")) throw new Error("invalid_proposal_fence");
  return JSON.parse(fenced[1]!);
}

const diagnosticFields = ["entryConditions", "steps", "outcome", "program", "prevention", "entry", "nodes", "kind", "operation", "next", "condition", "yes", "no", "fact", "test", "value", "op", "mode", "timeoutMs", "capability", "maxAncestorHops", "aspect", "source", "target", "direction", "count", "evidence"] as const;
const diagnosticKeys = new Set<string>(diagnosticFields);
type DiagnosticField = typeof diagnosticFields[number] | "unknown_field";
type ProposalIssue = { code: z.ZodIssueCode; path: (DiagnosticField | number)[] };
export type SkillProposalDiagnostic = {
  format: "json" | "code_fence" | "other";
  fields?: DiagnosticField[]; linearIssues?: ProposalIssue[]; graphIssues?: ProposalIssue[];
  channel?: "tool";
  rejection?: "unexpected_tool" | "multiple_tool_calls" | "invalid_arguments" | "missing_content";
};
/** Only fixed schema names and issue codes may leave the model response.
 * Unknown keys, supplied values and Zod's free-form messages are never emitted. */
export function diagnoseSkillProposal(content: string): SkillProposalDiagnostic {
  let input: unknown;
  try { input = decodeSkillProposalJson(content); }
  catch { return { format: content.trimStart().startsWith("```") ? "code_fence" : "other" }; }
  const issues = (result: z.SafeParseReturnType<unknown, unknown>): ProposalIssue[] => result.success ? [] : result.error.issues.slice(0, 8).map(issue => ({
    code: issue.code, path: issue.path.slice(0, 8).map(key => typeof key === "number" ? Math.max(0, Math.min(10_000, key)) : diagnosticKeys.has(key) ? key as DiagnosticField : "unknown_field"),
  }));
  return { format: content.trimStart().startsWith("```") ? "code_fence" : "json",
    fields: input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).slice(0, 32).map(key => diagnosticKeys.has(key) ? key as DiagnosticField : "unknown_field") : [],
    linearIssues: issues(SkillLinearProposalSchema.safeParse(input)), graphIssues: issues(SkillProposalSchema.safeParse(input)) };
}

type JsonSchema = { const?: unknown; enum?: unknown[]; type?: string; anyOf?: JsonSchema[]; oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>; required?: string[]; minimum?: number; maximum?: number };
/** Render the trusted Zod vocabulary as a compact type grammar, avoiding the
 * repeated JSON Schema property metadata. Strict validation remains in Zod. */
function grammar(schema: JsonSchema): string {
  if (schema.anyOf || schema.oneOf) return (schema.anyOf ?? schema.oneOf)!.map(grammar).join(" | ");
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join("|");
  if (schema.type === "object") return `{${Object.entries(schema.properties ?? {}).map(([key, value]) => `${key}${schema.required?.includes(key) ? "" : "?"}:${grammar(value)}`).join(",")}}`;
  if (schema.type === "integer") return `integer(${schema.minimum ?? "unbounded"}..${schema.maximum ?? "unbounded"})`;
  if (schema.type === "boolean") return "boolean";
  throw new Error("unsupported_skill_generation_grammar");
}
export const SKILL_PROPOSAL_GRAMMAR = [
  "Return JSON using quoted keys. Exact fields only; A[n..m] means an array with n to m entries.",
  `Predicate = ${grammar(zodToJsonSchema(PredicateSchema, { $refStrategy: "none" }) as JsonSchema)}`,
  `Operation = ${grammar(zodToJsonSchema(SkillOperationSchema, { $refStrategy: "none" }) as JsonSchema)}`,
  'LinearProcedure = {entryConditions:Predicate[0..6],steps:Operation[1..7],outcome:"continue"|"stop"}',
  'GraphProcedure = {entryConditions:Predicate[0..6],program:{entry:0,nodes:Node[2..8]}}',
  'Proposal = LinearProcedure or GraphProcedure; optionally add prevention:LinearProcedure or GraphProcedure. No recursive prevention field.',
  'Node = {kind:"step",operation:Operation,next:integer(0..7)} | {kind:"branch",condition:Predicate,yes:integer(0..7),no:integer(0..7)} | {kind:"end",outcome:"continue"|"stop"}',
].join("\n");

function proposalForWire(spec: SkillSpec): unknown {
  const procedure = (value: z.infer<typeof SkillProcedureSchema>) => {
    const nodes = value.program.nodes, end = nodes.at(-1)!;
    return end.kind === "end" && nodes.slice(0, -1).every((node, index) => node.kind === "step" && node.next === index + 1)
      ? { entryConditions: value.entryConditions, steps: nodes.slice(0, -1).map(node => node.kind === "step" ? node.operation : undefined), outcome: end.outcome }
      : { entryConditions: value.entryConditions, program: value.program };
  };
  return { ...procedure(spec), ...(spec.prevention ? { prevention: procedure(spec.prevention) } : {}) };
}
/** Lossless factoring of repeated sanitized observations. Every diagnostic,
 * before/after fact and ordering remains available; persisted traces stay in
 * their original form. Scope and feedback hashes are host-owned bindings, so
 * the generator does not need to reason about or reproduce them. */
export function generationEvidence(episode: FailureEpisode, parent: SkillSpec | undefined, feedback: readonly SkillFeedback[], evaluationFeedback?: SkillTrainingFeedback): unknown {
  const observations: ObservationFacts[] = [], indexes = new Map<string, number>();
  const observation = (facts: ObservationFacts) => {
    const serialized = JSON.stringify(facts), existing = indexes.get(serialized);
    if (existing !== undefined) return existing;
    const index = observations.length; observations.push(facts); indexes.set(serialized, index); return index;
  };
  const steps = episode.steps.map(({ before, after, ...step }) => ({ ...step, before: observation(before), after: observation(after) }));
  // The caller binds this strict payload to the parent before reaching the
  // model. Its hash is host-owned; only measured training facts are useful here.
  const evaluation = evaluationFeedback === undefined ? undefined : SkillTrainingFeedbackSchema.parse(evaluationFeedback);
  return { trigger: episode.trigger, observations, steps, termination: episode.termination,
    ...(parent ? { parent: proposalForWire(parent) } : {}),
    ...(evaluation ? { evaluationFeedback: { reason: evaluation.reason, pairs: evaluation.pairs } } : {}),
    negativeFeedback: feedback.map(({ skillHash: _hash, ...item }) => item) };
}
