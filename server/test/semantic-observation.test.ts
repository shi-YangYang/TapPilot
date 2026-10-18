import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Adb } from "../src/adb.js";
import { ApprovalQueue } from "../src/approvals.js";
import type { PhoneBridge } from "../src/bridge.js";
import { clientTools } from "../src/client-tools.js";
import { ToolController, type ToolName } from "../src/tools.js";
import { runAgent, type AgentOptions } from "../src/runtime/index.js";
import { signature } from "../src/runtime/context.js";
import { projectToolResult } from "../src/runtime/ui-projection.js";
import { executionEvidenceSchema } from "../src/observation-contract.js";
import { modelScope } from "../src/learning/schema.js";
import { SkillSpecSchema, SKILL_POLICY_REVISION } from "../src/skills/schema.js";
import { snapshot } from "./helpers.js";

type Json = Record<string, any>;
const quality = { status: "usable", reason: "accessible_content", actionableCount: 1, readableCount: 1 };
const execution = { dispatch: "sent", acceptance: "accepted", effect: "unknown", verification: "unverified" };
const tree = (revision = 1, unavailable = false): Json => ({ ...snapshot, snapshotId: `session:${revision}`, revision,
  observationContract: "semantic-v1", quality: unavailable ? { status: "unavailable", reason: "no_accessible_content", actionableCount: 0, readableCount: 0 } : quality,
  nodes: unavailable ? [{ ...snapshot.nodes[0], text: "", contentDescription: "", clickable: false, className: "android.view.View" }] : snapshot.nodes,
});
const ok = (result: Json) => ({ ok: true, result });
const waitResult = (revision = 2, unavailable = false): Json => ({ ...tree(revision, unavailable), changed: false, timedOut: true, matched: false,
  wait: { mode: "semantic", status: "timed_out", semanticChanged: false } });
const response = (result: unknown) => ({ id: "fixture", ok: true, result, meta: { durationMs: 0 } });

test("shared MCP/client controller attaches only the latest compatible matching-revision baseline", async () => {
  for (const scenario of ["current", "legacy", "wrong-revision", "changed-app", "partial-find", "failed-read", "lost-action", "explicit"] as const) {
    const seen: Json[] = [];
    let reads = 0;
    const bridge: PhoneBridge = { close: async () => {}, call: async (method, params) => {
      seen.push({ method, ...params });
      if (method === "get_ui_tree") {
        if (++reads > 1 && scenario === "failed-read") return { id: "fixture", ok: false, error: { code: "NO_ACTIVE_WINDOW", message: "Synthetic unavailable window", retryable: true }, meta: { durationMs: 0 } };
        return response(scenario === "legacy" ? snapshot : tree());
      }
      if (method === "get_current_app") return response({ packageName: "synthetic.other", windowId: 5 });
      if (method === "find_element") return response({ ...snapshot, nodes: undefined, elements: snapshot.nodes });
      if (method === "act_and_observe") return response({ action: { accepted: true }, execution, observation: null, observationError: { code: "NO_ACTIVE_WINDOW" } });
      return response(waitResult());
    } };
    const controller = new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted");
    try {
      await controller.invoke("get_ui_tree", {});
      if (scenario === "changed-app") await controller.invoke("get_current_app", {});
      if (scenario === "partial-find") await controller.invoke("find_element", { selector: { text: "Synthetic" } });
      if (scenario === "failed-read") await controller.invoke("get_ui_tree", {});
      if (scenario === "lost-action") await controller.invoke("press_key", { key: "back" });
      const result = (await controller.invoke("wait_for_ui_change", { sinceRevision: scenario === "wrong-revision" ? 0 : 1, timeoutMs: 100,
        ...(scenario === "explicit" ? { snapshotId: "session:explicit" } : {}) })).structuredContent as Json;
      assert.equal(result.ok, true, scenario);
      const actual = seen.at(-1)!;
      assert.equal(actual.snapshotId, scenario === "current" ? "session:1" : scenario === "explicit" ? "session:explicit" : undefined, scenario);
    } finally { await controller.close(); }
  }
});

const model = { baseUrl: "https://model.invalid/v1", apiKey: "synthetic-key", model: "fixture" };
async function run(plan: (turn: number, body: Json) => Json[] | undefined, execute: AgentOptions["execute"], extra: Partial<AgentOptions> = {}) {
  const requests: Json[] = [];
  const diagnostics: Json[] = [];
  const result = await runAgent({ ...extra, task: "Read the synthetic screen", tools: clientTools, execute, model,
    onDiagnostic: entry => { diagnostics.push(entry); },
    modelFetch: async (_url, init) => {
      const body = JSON.parse(init.body as string); const turn = requests.length; requests.push(body);
      const calls = plan(turn, body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: calls ? "tool_calls" : "stop", message: {
        role: "assistant", content: calls ? null : "Synthetic result", ...(calls ? { tool_calls: calls.map((call, index) => ({
          id: `fixture_${turn}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })) } : {}),
      } }], usage: { total_tokens: 1 } }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { result, requests, diagnostics };
}

test("modern waits return authoritative unchanged UI without an extra host read", async () => {
  const calls: string[] = [];
  const { result } = await run(turn => turn === 0 ? [{ name: "wait_for_ui_change", args: { sinceRevision: 1, timeoutMs: 1000 } }] : undefined,
    async name => { calls.push(name); return ok(name === "wait_for_ui_change" ? waitResult() : tree()); });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["get_ui_tree", "wait_for_ui_change", "get_ui_tree"], "the final read checks completion continuity only");
  assert.equal(result.metrics.hostReads, 1);
  assert.equal(result.metrics.completionReads, 1);
});

test("modern unchanged accepted action keeps unverified effect and does not schedule a redundant full read", async () => {
  const calls: string[] = [];
  const { result, diagnostics } = await run((turn, body) => {
    if (turn === 0) return [{ name: "act_and_observe", args: { action: "tap_element", arguments: { snapshotId: "session:1", nodeId: "n0" } } }];
    const latest = JSON.parse(body.messages.filter((message: Json) => message.role === "tool").at(-1).content);
    assert.deepEqual(latest.result.execution, { ...execution, effect: "unchanged" });
    assert.equal(latest.hostGuidance.code, "OBSERVATION_UNCHANGED");
    return undefined;
  }, async name => {
    calls.push(name);
    return ok(name === "act_and_observe" ? { action: { accepted: true }, execution: { ...execution, effect: "unchanged" }, observation: tree(2) } : tree());
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", "get_ui_tree"]);
  assert.equal(diagnostics.find(entry => entry.actionKind === "tap_element").effectState, "unchanged");
});

test("an inaccessible single-root screen gets one semantic recovery and zero model decisions", async () => {
  const calls: Json[] = [];
  const { result, requests, diagnostics } = await run(() => { throw new Error("Unusable UI must not reach the model"); }, async (name, args) => {
    calls.push({ name, args }); return ok(name === "get_ui_tree" ? tree(1, true) : waitResult(2, true));
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /VISION_REQUIRED/);
  assert.equal(requests.length, 0);
  assert.deepEqual(calls, [{ name: "get_ui_tree", args: {} }, { name: "wait_for_ui_change", args: { snapshotId: "session:1", sinceRevision: 1, timeoutMs: 1000 } }]);
  assert.equal(diagnostics.at(-1).errorCode, "VISION_REQUIRED");
});

test("bounded semantic recovery may expose usable UI without a model wait/read round", async () => {
  const calls: string[] = [];
  const { result, requests } = await run(() => undefined, async name => {
    calls.push(name);
    return ok(calls.length === 1 ? tree(1, true) : name === "wait_for_ui_change" ? { ...waitResult(), changed: true, timedOut: false,
      wait: { mode: "semantic", status: "changed", semanticChanged: true } } : tree(2));
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  assert.deepEqual(calls, ["get_ui_tree", "wait_for_ui_change", "get_ui_tree"]);
});

test("a change-only wait on an empty new window gets one phone readiness wait before another decision", async () => {
  const calls: { name: string; args: Json }[] = [];
  const capable = (revision: number, unavailable = false) => ({ ...tree(revision, unavailable),
    observationCapabilities: { readinessWait: true, actionSelectorWait: true } });
  let waits = 0;
  const { result, requests } = await run(turn => turn === 0
    ? [{ name: "wait_for_ui_change", args: { sinceRevision: 1, timeoutMs: 1000 } }] : undefined,
  async (name, args) => {
    calls.push({ name, args });
    if (name === "wait_for_ui_change" && ++waits === 1) return ok({ ...capable(2, true), windowId: 9,
      wait: { mode: "semantic", status: "window_changed", semanticChanged: true }, changed: true, timedOut: false, matched: false });
    if (name === "wait_for_ui_change") {
      assert.equal(args.requireUsable, true);
      return ok({ ...capable(3), windowId: 9, wait: { mode: "semantic", status: "changed", semanticChanged: true, requireUsable: true, ready: true } });
    }
    return ok({ ...capable(calls.length === 1 ? 1 : 3), windowId: calls.length === 1 ? snapshot.windowId : 9 });
  });
  assert.equal(result.status, "completed", result.error);
  assert.equal(requests.length, 2, "no model round is needed for transitional empty UI");
  assert.deepEqual(calls.map(call => call.name), ["get_ui_tree", "wait_for_ui_change", "wait_for_ui_change", "get_ui_tree"]);
});

test("readiness recovery is bounded even when a capable phone never exposes content", async () => {
  const calls: Json[] = [];
  const { result, requests } = await run(() => { throw new Error("No model decision on unavailable UI"); }, async (name, args) => {
    calls.push({ name, args });
    return ok({ ...tree(calls.length, true), observationCapabilities: { readinessWait: true },
      ...(name === "wait_for_ui_change" ? { wait: { mode: "semantic", status: "timed_out", semanticChanged: false, requireUsable: true, ready: false } } : {}) });
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /VISION_REQUIRED/);
  assert.equal(requests.length, 0);
  assert.deepEqual(calls, [{ name: "get_ui_tree", args: {} }, { name: "wait_for_ui_change",
    args: { snapshotId: "session:1", sinceRevision: 1, timeoutMs: 1000, requireUsable: true } }]);
});

test("shared controller forwards action selector waiting and scoped verification unchanged", async () => {
  const seen: Json[] = [];
  const verified = { ...execution, verification: "verified", verificationScope: "checked_state" };
  const observationWait = { status: "matched", ready: true };
  const controller = new ToolController({ close: async () => {}, call: async (method, args) => {
    seen.push({ method, args });
    return response(method === "act_and_observe" ? { action: { accepted: true }, observation: tree(2), execution: verified, observationWait } : tree());
  } }, new Adb(), new ApprovalQueue(), "trusted");
  try {
    await controller.invoke("get_ui_tree", {});
    const result = (await controller.invoke("act_and_observe", { action: "tap_element", arguments: { snapshotId: "session:1", nodeId: "n0" },
      waitFor: { resourceId: "synthetic:id/toggle" }, waitMs: 1000 })).structuredContent as Json;
    assert.equal(result.ok, true);
    assert.deepEqual(seen.at(-1)?.args.waitFor, { resourceId: "synthetic:id/toggle" });
    const projected = projectToolResult(result) as Json;
    assert.deepEqual(projected.result.execution, verified);
    assert.deepEqual(projected.result.observationWait, observationWait);
  } finally { await controller.close(); }
});

test("an explicit immediate semantic wait returning unavailable UI stops without another wait/read/model request", async () => {
  const calls: string[] = [];
  const { result, requests } = await run(() => [{ name: "wait_for_ui_change", args: { sinceRevision: 1, timeoutMs: 1 } }], async name => {
    calls.push(name); return ok(name === "get_ui_tree" ? tree() : waitResult(2, true));
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /VISION_REQUIRED/);
  assert.deepEqual(calls, ["get_ui_tree", "wait_for_ui_change"]);
  assert.equal(requests.length, 1);
});

test("accepted unknown effects get observation-only recovery and are never replayed", async () => {
  for (const missing of [false, true]) {
    const calls: string[] = [];
    const { result, requests, diagnostics } = await run(() => [{ name: "act_and_observe", args: {
      action: "tap_element", arguments: { snapshotId: "session:1", nodeId: "n0" },
    } }], async name => {
      calls.push(name);
      if (name === "act_and_observe") return ok({ action: { accepted: true }, execution, observation: missing ? null : tree(2, true),
        ...(missing ? { observationError: { code: "NO_ACTIVE_WINDOW" } } : {}) });
      return ok(calls.length === 1 ? tree() : name === "wait_for_ui_change" ? waitResult(3, true) : tree(3, true));
    });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /VISION_REQUIRED/);
    assert.equal(requests.length, 1);
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", missing ? "get_ui_tree" : "wait_for_ui_change"]);
    assert.equal(diagnostics.find(entry => entry.actionKind === "tap_element").effectState, "unknown");
  }
});

test("observation quality, wait outcome and execution metadata never manufacture semantic progress", () => {
  const initial = tree();
  const next = { ...tree(2), quality: { ...quality, status: "limited" }, wait: { mode: "semantic", status: "timed_out", semanticChanged: false },
    execution, changed: false, matched: false, timedOut: true, timestamp: 500 };
  assert.equal(signature(initial), signature(next));
  assert.notEqual(signature(initial), signature({ ...next, windowId: 5 }));
  const projected = projectToolResult({ ok: true, result: { execution: { ...execution, verification: "verified", verificationScope: "input_value" }, observation: waitResult() } }) as Json;
  assert.deepEqual(projected.result.execution, { ...execution, verification: "verified", verificationScope: "input_value" });
  assert.deepEqual(projected.result.observation.quality, quality);
  assert.equal(projected.result.observation.wait.mode, "semantic");
});

test("malformed verification evidence cannot claim proof or suppress observation recovery", async () => {
  for (const invalid of [{ ...execution, verification: "verified" }, { ...execution, verificationScope: "input_value" }]) {
    assert.equal(executionEvidenceSchema.safeParse(invalid).success, false);
    assert.equal((projectToolResult({ execution: invalid }) as Json).execution, undefined);
    const calls: string[] = [];
    const bridge: PhoneBridge = { close: async () => {}, call: async method => {
      calls.push(method);
      return response(method === "act_and_observe" ? { action: { accepted: true }, execution: invalid, observation: tree(2) } : tree());
    } };
    const controller = new ToolController(bridge, new Adb(), new ApprovalQueue(), "trusted");
    try {
      const { result } = await run(turn => turn === 0 ? [{ name: "act_and_observe", args: {
        action: "tap_element", arguments: { snapshotId: "session:1", nodeId: "n0" },
      } }] : undefined, async (name, args) => (await controller.invoke(name as ToolName, args)).structuredContent!);
      assert.equal(result.status, "completed");
      assert.deepEqual(calls, ["get_ui_tree", "act_and_observe", "get_ui_tree", "get_ui_tree"], "one observation recovery and a final continuity check, no mutation replay");
    } finally { await controller.close(); }
  }
  assert.equal(executionEvidenceSchema.safeParse(execution).success, true);
  assert.equal(executionEvidenceSchema.safeParse({ ...execution, verification: "verified", verificationScope: "input_value" }).success, true);
  const calls: string[] = [];
  const controller = new ToolController({ close: async () => {}, call: async method => {
    calls.push(method);
    return response(method === "act_and_observe" ? { action: { accepted: true }, execution: { ...execution, verification: "verified" },
      observation: null, observationError: { code: "PROTECTED_APP" } } : tree());
  } }, new Adb(), new ApprovalQueue(), "trusted");
  try {
    const { result } = await run(() => [{ name: "act_and_observe", args: { action: "press_key", arguments: { key: "home" } } }],
      async (name, args) => (await controller.invoke(name as ToolName, args)).structuredContent!);
    assert.match(result.error!, /PROTECTED_APP/);
    assert.deepEqual(calls, ["get_ui_tree", "act_and_observe"], "malformed execution must not replace an existing terminal protection error with a recoverable one");
  } finally { await controller.close(); }
});

test("a preventive skill consumes the modern wait observation without a second full read", async () => {
  const candidate = SkillSpecSchema.parse({ schemaVersion: 1,
    scope: { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: modelScope(model).modelProfile,
      appDigest: createHash("sha256").update(snapshot.packageName).digest("hex") },
    trigger: { errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", actionKind: "input_text" },
    entryConditions: [{ fact: "priorActionAccepted", test: "eq", value: "no" }],
    program: { entry: 0, nodes: [{ kind: "step", operation: { op: "inspect", aspect: "context" }, next: 1 }, { kind: "end", outcome: "continue" }] },
    prevention: { entryConditions: [{ fact: "observedLabelChanges", test: "eq", value: "yes" }], program: { entry: 0, nodes: [
      { kind: "step", operation: { op: "inspect_changed_labels" }, next: 1 },
      { kind: "step", operation: { op: "allow_unrelated_status_labels" }, next: 2 }, { kind: "end", outcome: "continue" }] } },
    lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 100_000 });
  const current = (revision: number) => {
    const base = { ...snapshot.nodes[0], checkable: false, checked: false, selected: false, focused: false, visible: true };
    return { ...tree(revision), nodes: [
      { ...base, nodeId: "root", parentId: null, text: "", contentDescription: "", clickable: false, bounds: [0, 0, 300, 500] },
      { ...base, nodeId: "status", parentId: "root", text: `Synthetic status ${revision}`, clickable: false, bounds: [0, 10, 200, 40] },
      { ...base, parentId: "root" },
    ] };
  };
  const calls: string[] = [];
  const used: string[][] = [];
  let request: Json | undefined;
  const { result } = await run((_turn, body) => {
    request = body;
    return undefined;
  }, async name => {
    calls.push(name);
    return ok(name === "wait_for_ui_change" ? { ...waitResult(), ...current(2) } : current(calls.length === 1 ? 1 : 2));
  }, { diagnosticVersion: "0.3.19", skillSnapshot: [candidate], onSkillUsed: hashes => { used.push([...hashes]); } });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["get_ui_tree", "wait_for_ui_change", "get_ui_tree"]);
  assert.equal(used.length, 1);
  assert.match(request!.messages[0].content, /Validated preventive hint/);
  const latest = JSON.parse(request!.messages.filter((message: Json) => message.role === "tool").at(-1).content);
  assert.deepEqual(latest.result.changedLabelNodeIds, ["status"]);
});
