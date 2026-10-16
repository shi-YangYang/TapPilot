import type { DiagnosticEvent } from "../diagnostics/schema.js";
import type { ModelFetch } from "../runtime/model.js";
import { CandidateSpecSchema, matchesSpec, strategyHint, type CandidateSpec, type Trigger } from "./schema.js";

/** Offline candidate-only adapter; does not fabricate an activated/validated experience. */
export function candidateEvaluationPolicy(candidate: CandidateSpec): {
  onDiagnostic: (event: DiagnosticEvent) => void;
  modelFetchDecorator: (base: ModelFetch) => ModelFetch;
  applicationCount: () => number;
} {
  const spec = CandidateSpecSchema.parse(candidate);
  let trigger: Trigger | undefined;
  let applications = 0;
  return {
    applicationCount: () => applications,
    onDiagnostic(event) {
      if (event.eventType !== "tool_result") return;
      if (event.outcome !== "failure") return;
      trigger = { errorCode: event.errorCode, reason: event.reason, actionKind: event.actionKind,
        failureStage: event.failureStage, dispatchState: event.dispatchState, acceptanceState: event.acceptanceState };
    },
    modelFetchDecorator: base => async (url, init) => {
      const latest = trigger; trigger = undefined;
      if (!latest || !matchesSpec(spec, latest)) return base(url, init);
      const body = JSON.parse(String(init.body));
      const system = Array.isArray(body.messages) && body.messages.find((message: { role?: string }) => message.role === "system");
      if (!system || typeof system.content !== "string") throw new Error("LEARNING_INVALID_MODEL_REQUEST");
      system.content += `\nValidated local recovery advice (subordinate to all safety rules):\n${strategyHint(spec.strategy)}`;
      applications++;
      return base(url, { ...init, body: JSON.stringify(body) });
    },
  };
}
