import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, stat, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiagnosticEventSchema, DiagnosticStore, createDiagnosticRunId,
  safeDiagnosticActionKind, safeDiagnosticErrorCode, safeDiagnosticReason, summarizeFailures, type DiagnosticEvent,
} from "../src/diagnostics/index.js";

function event(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return { schemaVersion: 1, eventType: "tool_result", runId: createDiagnosticRunId(), timestamp: 1000, stepIndex: 1,
    actionKind: "input_text", outcome: "failure", failureStage: "unknown", dispatchState: "unknown", acceptanceState: "unknown",
    effectState: "unknown", errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", versions: { host: "0.3.19" }, ...overrides };
}

async function fixture(options: { maxRecords?: number; maxBytes?: number; maxQueue?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tappilot-diagnostics-test-"));
  const store = new DiagnosticStore({ rootDirectory: directory, ...options });
  return { directory, store, close: async () => { await store.flush(); await rm(directory, { recursive: true, force: true }); } };
}

test("diagnostics reject all non-whitelisted content, including nested extras and raw code/reason text", async () => {
  const f = await fixture();
  try {
    const forbidden = ["task", "answer", "model", "serial", "apiKey", "baseUrl", "nodes", "text", "message", "input"];
    for (const field of forbidden) assert.equal((await f.store.append({ ...event(), [field]: "synthetic-secret" })).stored, false);
    for (const value of [
      event({ errorCode: "synthetic-secret" as DiagnosticEvent["errorCode"] }),
      event({ reason: "synthetic-secret" as DiagnosticEvent["reason"] }),
      { ...event(), changes: { observationChanged: true, text: "synthetic-secret" } },
      { ...event(), timings: { toolMs: -1 } },
      { ...event(), versions: { host: "0.3.19-secret" } },
      { ...event(), runId: "serial-device-id" },
      Object.defineProperty({}, "schemaVersion", { get() { throw new Error("synthetic-secret"); } }),
    ]) assert.deepEqual(await f.store.append(value), { stored: false, reason: "invalid_event" });
    assert.deepEqual(await f.store.append(event()), { stored: true });
    const raw = await readFile(join(f.store.directory, "events.jsonl"), "utf8");
    assert.equal(raw.includes("synthetic-secret"), false);
    assert.equal((await f.store.list()).length, 1);
    assert.equal(safeDiagnosticErrorCode("pretend NODE_NOT_ACTIONABLE"), "UNKNOWN");
    assert.equal(safeDiagnosticReason("text changed"), "UNKNOWN");
    assert.equal(safeDiagnosticActionKind("upload_data"), "unknown");
  } finally { await f.close(); }
});

test("optional navigation diagnostics distinguish found targets from dispatch success and reject private search data", () => {
  const navigation = { completedSteps: 3, stopReason: "max_steps" as const, targetFound: false };
  const base = event({ actionKind: "navigate_until", outcome: "success", failureStage: "none", dispatchState: "sent",
    acceptanceState: "accepted", effectState: "changed", errorCode: "NONE", reason: "NONE", navigation });
  assert.equal(DiagnosticEventSchema.safeParse(base).success, true);
  assert.equal(DiagnosticEventSchema.safeParse(event()).success, true, "existing records without navigation remain compatible");
  assert.equal(safeDiagnosticErrorCode("NAVIGATION_EXHAUSTED"), "NAVIGATION_EXHAUSTED");
  for (const stopReason of ["target_candidate", "already_explored", "scope_changed"] as const) {
    assert.equal(DiagnosticEventSchema.safeParse({ ...base, navigation: { ...navigation, stopReason } }).success, true);
  }
  assert.equal(DiagnosticEventSchema.safeParse({ ...base, navigation: { ...navigation, stopReason: "target_found", targetFound: true } }).success, true);
  for (const field of ["selector", "candidateNodeIds", "text", "packageName", "fingerprint", "message"]) {
    assert.equal(DiagnosticEventSchema.safeParse({ ...base, navigation: { ...navigation, [field]: "synthetic-private" } }).success, false);
  }
  for (const invalid of [
    { ...base, actionKind: "swipe" },
    { ...base, eventType: "model_result" },
    { ...base, navigation: { ...navigation, targetFound: true } },
    { ...base, navigation: { ...navigation, stopReason: "target_found" } },
    { ...base, navigation: { ...navigation, completedSteps: 5 } },
    { ...base, navigation: { ...navigation, stopReason: "synthetic-private" } },
  ]) assert.equal(DiagnosticEventSchema.safeParse(invalid).success, false);
});

test("records remain bounded by count and bytes, preserve order, and use private filesystem modes", async () => {
  const f = await fixture({ maxRecords: 3, maxBytes: 2048 });
  try {
    for (let stepIndex = 0; stepIndex < 6; stepIndex++) assert.equal((await f.store.append(event({ stepIndex }))).stored, true);
    assert.deepEqual((await f.store.list()).map(item => item.stepIndex), [3, 4, 5]);
    assert.ok((await stat(join(f.store.directory, "events.jsonl"))).size <= 2048);
    assert.equal((await stat(f.store.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.store.directory, "events.jsonl"))).mode & 0o777, 0o600);
    const tight = new DiagnosticStore({ rootDirectory: f.directory, maxRecords: 100, maxBytes: 2048 });
    for (let stepIndex = 6; stepIndex < 11; stepIndex++) await tight.append(event({ stepIndex }));
    const kept = await tight.list();
    assert.ok(kept.length < 6);
    assert.equal(kept.at(-1)?.stepIndex, 10);
    assert.ok((await stat(join(f.store.directory, "events.jsonl"))).size <= 2048);
  } finally { await f.close(); }
});

test("an overloaded queue drops events without delaying or rejecting callers", async () => {
  const f = await fixture({ maxQueue: 1 });
  try {
    const first = f.store.append(event());
    const overflow = await f.store.append(event());
    assert.deepEqual(overflow, { stored: false, reason: "queue_full" });
    assert.deepEqual(await first, { stored: true });
    await f.store.flush();
    assert.deepEqual(f.store.status(), { dropped: 1, storageUnavailable: false, queued: 0 });
  } finally { await f.close(); }
});

test("clustering reports repeated evidence, separates unknown from known dispatch, and never invents a cause", () => {
  const first = event();
  const second = event({ runId: first.runId, timestamp: 2000 });
  const third = event({ timestamp: 3000 });
  const rejected = event({ dispatchState: "not_sent", acceptanceState: "rejected", failureStage: "host_validation" });
  const success = event({ outcome: "success", failureStage: "none", errorCode: "NONE", reason: "NONE" });
  const summaries = summarizeFailures([first, second, third, rejected, success]);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0]?.count, 3);
  assert.equal(summaries[0]?.runCount, 2);
  assert.equal(summaries[0]?.firstSeen, 1000);
  assert.equal(summaries[0]?.lastSeen, 3000);
  assert.equal(summaries[0]?.dispatchState, "unknown");
  assert.ok(summaries.every(item => item.cause === "unknown" && item.evidence === "reported_metadata"));
});

test("corrupt and partial JSONL rows are not evidence and are removed during bounded replacement", async () => {
  const f = await fixture();
  try {
    const one = event();
    await f.store.append(one);
    await writeFile(join(f.store.directory, "events.jsonl"), `${JSON.stringify(one)}\n{"broken":\n${JSON.stringify({ ...one, task: "synthetic-private" })}\n`);
    assert.deepEqual(await f.store.list(), [one]);
    await f.store.append(event({ stepIndex: 2 }));
    const raw = await readFile(join(f.store.directory, "events.jsonl"), "utf8");
    assert.equal(raw.includes("synthetic-private"), false);
    assert.equal((await f.store.list()).length, 2);
  } finally { await f.close(); }
});

test("foreign directories and symlink targets are never adopted, overwritten, or cleared", async () => {
  const f = await fixture();
  try {
    await mkdir(f.store.directory);
    await writeFile(join(f.store.directory, "events.jsonl"), "foreign-content");
    assert.equal((await f.store.append(event())).stored, false);
    assert.deepEqual(await f.store.clear(), { cleared: false });
    assert.equal(await readFile(join(f.store.directory, "events.jsonl"), "utf8"), "foreign-content");
    await rm(f.store.directory, { recursive: true });
    await f.store.append(event());
    const outside = join(f.directory, "unrelated.txt");
    await writeFile(outside, "keep-this");
    await rm(join(f.store.directory, "events.jsonl"));
    await symlink(outside, join(f.store.directory, "events.jsonl"));
    assert.equal((await f.store.append(event())).stored, false);
    assert.deepEqual(await f.store.clear(), { cleared: false });
    assert.equal(await readFile(outside, "utf8"), "keep-this");
  } finally { await f.close(); }
});

test("clear is scoped to owned events and shared instances serialize writes", async () => {
  const f = await fixture();
  const other = new DiagnosticStore({ rootDirectory: f.directory });
  try {
    await Promise.all([f.store.append(event({ stepIndex: 1 })), other.append(event({ stepIndex: 2 }))]);
    assert.deepEqual((await f.store.list()).map(item => item.stepIndex), [1, 2]);
    await writeFile(join(f.store.directory, "unrelated.txt"), "keep-this");
    assert.deepEqual(await f.store.clear(), { cleared: true });
    assert.deepEqual(await f.store.list(), []);
    assert.equal(await readFile(join(f.store.directory, "unrelated.txt"), "utf8"), "keep-this");
    assert.equal((await f.store.append(event())).stored, true);
  } finally { await f.close(); }
});

test("unavailable roots and unsafe large files remain a non-throwing optional diagnostic failure", async () => {
  const f = await fixture({ maxBytes: 1024 });
  try {
    const unavailable = new DiagnosticStore({ rootDirectory: join(f.directory, "missing-parent") });
    assert.deepEqual(await unavailable.append(event()), { stored: false, reason: "storage_unavailable" });
    assert.deepEqual(await unavailable.list(), []);
    await f.store.append(event());
    await writeFile(join(f.store.directory, "events.jsonl"), "x".repeat(1025));
    assert.deepEqual(await f.store.list(), []);
    assert.deepEqual(await f.store.append(event()), { stored: false, reason: "storage_unavailable" });
    assert.equal(DiagnosticEventSchema.safeParse(event({ timings: { snapshotAgeMs: Number.POSITIVE_INFINITY } })).success, false);
  } finally { await f.close(); }
});
