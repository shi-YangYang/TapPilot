import test from "node:test";
import assert from "node:assert/strict";
import { generateScenarios, runScenario, observedPolicy } from "../src/eval/index.js";
import { runAgent } from "../src/runtime/index.js";
import { clientTools } from "../src/client-tools.js";

test("a model cannot continue a replaced phone session by selecting a newly rebound node", async () => {
  const scenario = generateScenarios({ mechanisms: ["session_change"] })[0]!;
  const result = await runScenario(scenario, { fixturePolicy: (tree, body, state) => {
    // Deliberately disregard the prior refusal. The runtime must stop before
    // this policy can turn a new observation into a second mutation attempt.
    const clean = { ...body, messages: [] };
    return observedPolicy(tree, clean, state);
  } });
  assert.equal(result.verdict, "rejected_safe");
  assert.equal(result.agentStatus, "failed");
  assert.equal(result.mutations, 0);
  assert.equal(result.falseCompletion, false);
  assert.equal(result.metrics.modelRequests, 1);
});

test("session pin survives invalidated observations before the automatic recovery read", async () => {
  for (const accepted of [false, true]) {
    let reads = 0, actions = 0, models = 0;
    const result = await runAgent({ task: "Open the synthetic target", tools: clientTools,
      model: { baseUrl: "https://fixture.invalid/v1", model: "fixture", apiKey: "" },
      execute: async name => {
        if (name === "get_ui_tree") return { ok: true, result: {
          snapshotId: ++reads === 1 ? "initial:1" : "replacement:2", revision: reads, packageName: "synthetic.app", windowId: 1,
          truncated: false, nodes: [{ nodeId: "target", text: "Synthetic target", clickable: true, enabled: true }],
        } };
        actions++;
        return accepted ? { ok: true, result: { action: { accepted: true } } } : { ok: false, error: { code: "STALE_SNAPSHOT" } };
      },
      modelFetch: async () => {
        models++;
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
          { id: `call-${models}`, type: "function", function: { name: "act_and_observe", arguments: JSON.stringify({
            action: "tap_element", arguments: { snapshotId: "initial:1", nodeId: "target" },
          }) } },
        ] } }] }));
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error!, /TARGET_CHANGED/);
    assert.equal(models, 1); assert.equal(actions, 1); assert.equal(reads, 2);
  }
});
