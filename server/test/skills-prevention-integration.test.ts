import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runAgent } from "../src/runtime/index.js";
import { clientTools } from "../src/client-tools.js";
import { fullObservation } from "../src/runtime/context.js";
import { modelScope } from "../src/learning/schema.js";
import { SKILL_POLICY_REVISION, SkillSpecSchema, skillHash } from "../src/skills/schema.js";
import type { TraceStep } from "../src/skills/trace.js";

const model = { baseUrl: "https://fixture.invalid/v1", apiKey: "", model: "fixture" };
const pkg = "synthetic.prevention";
const tree = (revision: number, typed = "") => ({ snapshotId: `fixture-session:${revision}`, revision,
  packageName: pkg, windowId: 1, truncated: false, nodes: [
    { nodeId: "root", className: "android.widget.LinearLayout", bounds: [0, 0, 400, 800], enabled: true, visible: true },
    { nodeId: "status", parentId: "root", className: "android.widget.TextView", resourceId: `${pkg}:id/status`,
      bounds: [0, 0, 400, 40], text: `Synthetic status ${revision}`, enabled: true, visible: true },
    { nodeId: "field", parentId: "root", className: "android.widget.EditText", resourceId: `${pkg}:id/field`,
      bounds: [0, 50, 400, 100], text: typed, editable: true, enabled: true, visible: true },
  ].map(node => ({ checked: false, selected: false, focused: false, ...node })) });
const spec = () => SkillSpecSchema.parse({ schemaVersion: 1,
  scope: { hostVersion: "0.3.19", policyRevision: SKILL_POLICY_REVISION, modelProfile: modelScope(model).modelProfile,
    appDigest: createHash("sha256").update(pkg).digest("hex") },
  trigger: { errorCode: "TARGET_CHANGED", reason: "PAGE_CONTEXT_CHANGED", actionKind: "input_text" },
  entryConditions: [], program: { entry: 0, nodes: [
    { kind: "step", operation: { op: "observe", mode: "reuse_latest" }, next: 1 }, { kind: "end", outcome: "continue" },
  ] }, prevention: { entryConditions: [{ fact: "observedLabelChanges", test: "eq", value: "yes" }], program: { entry: 0, nodes: [
    { kind: "step", operation: { op: "inspect_changed_labels" }, next: 1 },
    { kind: "step", operation: { op: "allow_unrelated_status_labels" }, next: 2 },
    { kind: "end", outcome: "continue" },
  ] } }, lineage: { negativeFeedback: [] }, basis: "hypothesis", expiresAt: Date.now() + 60_000 });

test("prevention compares the initial and each accepted action state without extra model calls or fabricated refusals", async () => {
  for (const eligible of [true, false]) {
    const skill = spec();
    if (!eligible) skill.scope.appDigest = "b".repeat(64);
    let reads = 0, waits = 0, requests = 0, revision = 0, actions = 0, typed = "";
    const used: string[] = [], traces: TraceStep[] = [];
    const result = await runAgent({ task: "Fill the synthetic field twice with the requested successive values", model, tools: clientTools,
      diagnosticVersion: "0.3.19", skillSnapshot: [skill],
      onSkillUsed: hashes => { used.push(...hashes); }, onSkillTrace: step => { traces.push(step); },
      execute: async (name, args) => {
        if (name === "get_ui_tree") { reads++; return { ok: true, result: tree(++revision, typed) }; }
        if (name === "wait_for_ui_change") { waits++; return { ok: true, result: { changed: true, revision: revision + 1 } }; }
        const input = args.arguments as Record<string, unknown>;
        assert.equal(input.snapshotId, `fixture-session:${revision}`);
        assert.deepEqual(input.allowedLabelChanges, eligible ? ["status"] : undefined);
        assert.equal(input.text, `Synthetic input ${++actions}`);
        typed = String(input.text);
        return { ok: true, result: { action: { accepted: true }, observation: tree(++revision, typed) } };
      },
      modelFetch: async (_url, init) => {
        const payload = JSON.parse(String(init.body));
        const current = payload.messages.filter((m: any) => m.role === "tool").map((m: any) => fullObservation(JSON.parse(m.content))).filter(Boolean).at(-1);
        requests++;
        assert.equal(current.snapshotId, `fixture-session:${revision}`);
        assert.deepEqual(current.changedLabelNodeIds, eligible ? ["status"] : undefined);
        assert.equal(used.length, eligible ? requests : 0);
        const call = requests <= 2 ? { id: `synthetic-input-${requests}`, type: "function", function: { name: "act_and_observe", arguments: JSON.stringify({
          action: "input_text", arguments: { snapshotId: current.snapshotId, nodeId: "field", text: `Synthetic input ${requests}`,
            ...(eligible ? { allowedLabelChanges: ["status"] } : {}) },
        }) } } : undefined;
        return new Response(JSON.stringify({ choices: [{ finish_reason: call ? "tool_calls" : "stop", message: {
          role: "assistant", content: call ? null : "Done", ...(call ? { tool_calls: [call] } : {}),
        } }] }));
      },
    });
    assert.equal(result.status, "completed", result.error);
    assert.equal(requests, 3);
    assert.equal(actions, 2);
    assert.equal(waits, eligible ? 3 : 0);
    assert.equal(reads, eligible ? 5 : 2);
    assert.deepEqual(used, eligible ? [skillHash(skill), skillHash(skill), skillHash(skill)] : []);
    assert.ok(traces.every(step => step.errorCode === "NONE" && step.executor === undefined));
  }
});
