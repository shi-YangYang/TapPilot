import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticEventSchema, safeContextChange, type DiagnosticEvent } from "../src/diagnostics/schema.js";
import { generateContinuousContextScenarios } from "../src/eval/scenarios.js";
import { runScenario } from "../src/eval/runner.js";
import { ScenarioPhone } from "../src/eval/synthetic-phone.js";
import { compactTrace, TraceStepSchema, type TraceStep } from "../src/skills/trace.js";

test("native reference sees continuous same-collection peer updates without retrying the intended whole item", async () => {
  for (const scenario of generateContinuousContextScenarios().filter(s => !s.safetyExpected)) {
    const events: DiagnosticEvent[] = [], traces: TraceStep[] = [];
    let phone!: ScenarioPhone;
    const result = await runScenario(scenario, { diagnosticVersion: "0.3.19", onDiagnostic: event => events.push(event), onSkillTrace: step => traces.push(step),
      phoneFactory: value => (phone = new ScenarioPhone(value)) });
    assert.equal(result.verdict, "goal", JSON.stringify(result));
    assert.equal(result.mutations, 1);
    assert.equal(result.dispatches, 1);
    assert.equal(result.metrics.modelRequests, 2);
    assert.equal(result.errors.includes("TARGET_CHANGED"), false);
    assert.ok(phone.reads >= 2, "The native executor captures a fresh tree before dispatch");
    // node-v1 does not transmit structural change evidence. Do not invent it.
    assert.ok(events.every(event => event.contextChange === undefined));
    assert.ok(traces.every(step => step.contextChange === undefined));
  }
});

test("page title and another collection's account context keep changing; both stop without actions or endless retries", async () => {
  for (const scenario of generateContinuousContextScenarios().filter(s => s.safetyExpected)) {
    const events: DiagnosticEvent[] = [], traces: TraceStep[] = [];
    let phone!: ScenarioPhone;
    const result = await runScenario(scenario, { diagnosticVersion: "0.3.19", onDiagnostic: event => events.push(event), onSkillTrace: step => traces.push(step),
      phoneFactory: value => (phone = new ScenarioPhone(value)) });
    assert.equal(result.verdict, "rejected_safe", JSON.stringify(result));
    assert.equal(result.agentStatus, "failed");
    assert.equal(result.mutations, 0);
    assert.equal(result.dispatches, 0);
    assert.equal(result.falseCompletion, false);
    assert.ok(result.errors.includes("PAGE_CONTEXT_UNSTABLE"));
    assert.equal(result.metrics.modelRequests, 2);
    assert.ok(phone.state.contextChanged);
    const refusals = events.filter(event => event.reason === "PAGE_CONTEXT_CHANGED" && event.eventType === "tool_result");
    assert.equal(refusals.length, 2);
    assert.deepEqual(refusals.map(event => event.contextConflictCount), [1, 2]);
    assert.ok(refusals.every(event => event.dispatchState === "not_sent" && event.acceptanceState === "rejected"));
    assert.ok(refusals.every(event => event.failureStage === "phone_validation" && event.contextChange === undefined));
    assert.ok(traces.some(step => step.contextConflictCount === 2 && step.contextChange === undefined));
  }
});

test("change evidence rejects text, handles, arbitrary reasons and nested sensitive fields", () => {
  const evidence = { region: "outside_target", kind: "content", changedNodes: 1, targetMatched: true, actionTargetMatched: true } as const;
  assert.deepEqual(safeContextChange(evidence), evidence);
  for (const extra of [{ text: "synthetic-private" }, { nodeId: "private-handle" }, { region: "recipient-name" }, { changedNodes: 501 }]) {
    assert.equal(safeContextChange({ ...evidence, ...extra }), undefined);
  }
  const diagnostic = { actionKind: "tap_element", errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown", contextChange: evidence, contextConflictCount: 2 } as const;
  const trace = compactTrace({ index: 1, diagnostic });
  assert.deepEqual(trace.contextChange, evidence);
  assert.equal(trace.contextConflictCount, 2);
  assert.equal(TraceStepSchema.safeParse({ ...trace, contextChange: { ...evidence, text: "synthetic-private" } }).success, false);
  assert.equal(DiagnosticEventSchema.shape.contextChange.safeParse({ ...evidence, text: "synthetic-private" }).success, false);
  assert.equal(DiagnosticEventSchema.shape.contextConflictCount.safeParse(3).success, false);
});
