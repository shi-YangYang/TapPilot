import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phoneErrorSchema, phoneResponseSchema } from "../src/bridge.js";
import { DiagnosticEventSchema, VisualComparisonSchema, createDiagnosticRunId, type DiagnosticEvent } from "../src/diagnostics/schema.js";
import { DiagnosticStore } from "../src/diagnostics/store.js";
import { compactTrace, factsFromTrace } from "../src/skills/trace.js";
import { visualComparison, visualDetails, visualError } from "./visual-refusal-fixture.js";

test("visual comparison accepts fixed bounded counts, dimension mismatch and post-comparison age", () => {
  assert.equal(VisualComparisonSchema.safeParse(visualComparison()).success, true);
  assert.equal(VisualComparisonSchema.safeParse({ ...visualComparison(), referenceAgeMs: Number.MAX_SAFE_INTEGER }).success, true);
  assert.equal(VisualComparisonSchema.safeParse({ ...visualComparison(), triggers: ["dimensions"],
    globalChangedPixels: null, globalMeanRgbMilli: null, localPixelCount: null, localChangedPixels: null, localMeanRgbMilli: null }).success, true);
  for (const patch of [
    { triggers: [] }, { triggers: ["local_pixels", "local_pixels"] }, { triggers: ["synthetic-private"] },
    { triggers: ["dimensions", "local_pixels"] }, { triggers: ["dimensions"] },
    { referenceAgeMs: -1 }, { referenceAgeMs: 1.5 }, { referenceAgeMs: Number.MAX_SAFE_INTEGER + 1 },
    { globalPixelCount: 0 }, { globalPixelCount: 409601 }, { globalChangedPixels: 1025 },
    { globalMeanRgbMilli: 255001 }, { localPixelCount: 1025 }, { localChangedPixels: 26 },
    { localChangedPixels: 9 }, { localMeanRgbMilli: -1 }, { localChangedPixels: null },
    { globalMeanRgbMilli: Number.NaN }, { image: "synthetic-private" }, { x: 7 },
  ]) assert.equal(VisualComparisonSchema.safeParse({ ...visualComparison(), ...patch }).success, false, JSON.stringify(patch));
});

test("only a strict visual scene refusal may carry visual proof, never an attached native observation", () => {
  assert.equal(phoneErrorSchema.safeParse(visualError()).success, true);
  const envelope = { id: "synthetic", ok: false, error: visualError(), meta: { durationMs: 1 } };
  assert.equal(phoneResponseSchema.safeParse(envelope).success, true);
  assert.equal(phoneResponseSchema.safeParse({ ...envelope, observation: { executor: "node-v1" } }).success, false);
  for (const error of [
    { ...visualError(), code: "TARGET_CHANGED" }, { ...visualError(), code: "VISUAL_CONTEXT_CHANGED" },
    { ...visualError(), details: { ...visualDetails(), executor: "node-v1" } },
    { ...visualError(), details: { ...visualDetails(), dispatchState: "sent" } },
    { ...visualError(), details: { ...visualDetails(), reason: "PAGE_CONTEXT_CHANGED" } },
    { ...visualError(), details: { ...visualDetails(), targetDescription: "synthetic-private" } },
  ]) assert.equal(phoneErrorSchema.safeParse(error).success, false);
  assert.equal(phoneErrorSchema.safeParse({ code: "VISUAL_SCENE_CHANGED", message: "Legacy", retryable: false }).success, true);
});

test("diagnostic storage retains numeric visual evidence and rejects mismatched proof or private extras", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tappilot-visual-diagnostics-test-"));
  const store = new DiagnosticStore({ rootDirectory: directory });
  const event: DiagnosticEvent = { schemaVersion: 1, eventType: "tool_result", runId: createDiagnosticRunId(),
    timestamp: 1000, stepIndex: 1, actionKind: "tap_visual", executor: "visual-tap-v1", outcome: "failure",
    failureStage: "phone_validation", dispatchState: "not_sent", acceptanceState: "rejected", effectState: "unknown",
    errorCode: "VISUAL_SCENE_CHANGED", reason: "UNKNOWN", visualComparison: visualComparison(), versions: { host: "0.3.19" } };
  try {
    const trace = compactTrace({ index: 0, diagnostic: event });
    assert.equal(trace.executor, undefined);
    assert.equal("visualComparison" in trace, false);
    assert.equal(factsFromTrace(trace).nativeContextChange, "unknown");
    assert.deepEqual(await store.append(event), { stored: true });
    for (const patch of [
      { executor: "node-v1" }, { executor: undefined }, { dispatchState: "sent" }, { acceptanceState: "accepted" },
      { failureStage: "unknown" }, { actionKind: "tap_element" }, { errorCode: "TARGET_CHANGED" },
      { eventType: "run_finished" }, { visualComparison: undefined },
      { visualComparison: { ...visualComparison(), pixels: "synthetic-private" } }, { captureId: "synthetic-private" },
    ]) {
      assert.equal(DiagnosticEventSchema.safeParse({ ...event, ...patch }).success, false);
      assert.deepEqual(await store.append({ ...event, ...patch }), { stored: false, reason: "invalid_event" });
    }
    assert.deepEqual(await store.list(), [event]);
    const persisted = await readFile(join(store.directory, "events.jsonl"), "utf8");
    assert.equal(persisted.includes("synthetic-private"), false);
    assert.deepEqual(JSON.parse(persisted).visualComparison, visualComparison());
  } finally { await store.flush(); await rm(directory, { recursive: true, force: true }); }
});
