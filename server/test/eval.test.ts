import assert from "node:assert/strict";
import test from "node:test";
import { generateScenarios, MECHANISMS, runEvaluation, runScenario, summarize, judge, observedPolicy } from "../src/eval/index.js";
import { ScenarioPhone } from "../src/eval/synthetic-phone.js";

test("120 seeded scenarios exercise production runtime/client/controller and independent business oracles", async () => {
  const scenarios = generateScenarios();
  assert.equal(scenarios.length, 120);
  for (const mechanism of MECHANISMS) assert.equal(scenarios.filter(s => s.mechanism === mechanism).length, 10);
  const train = generateScenarios({ split: "train" }), holdout = generateScenarios({ split: "holdout" });
  assert.equal(new Set([...train, ...holdout].map(s => s.id)).size, 120);
  assert.ok(holdout.some(s => !train.some(t => t.mechanism === s.mechanism)), "Entire mechanisms are held out too");
  const report = await runEvaluation(scenarios);
  const failures = report.results.filter(r => !["goal", "rejected_safe"].includes(r.verdict));
  assert.deepEqual(failures, []);
  assert.equal(report.summary.goal, 100);
  assert.equal(report.summary.rejectedSafe, 20);
  assert.equal(report.summary.wrongActionRate, 0);
  assert.equal(report.summary.falseCompletionRate, 0);
  assert.equal(report.results.filter(r => r.recovered).length, 5);
  assert.ok(report.summary.modelRequests > 120);
  assert.ok(report.summary.modelUiBytes < report.summary.rawUiBytes);
  for (const result of report.results.filter(r => r.mechanism === "lost_response")) {
    assert.equal(result.agentStatus, "failed", "Transport failure cannot prove task failure or justify replay");
    assert.equal(result.mutations, 1, "An applied action whose response was lost is never replayed");
    assert.equal(result.verdict, "goal", "Independent state proves the business effect despite transport failure");
  }
  assert.equal(summarize(report.results.filter(r => r.verdict === "rejected_safe")).taskSuccessRate, null, "Safe rejection is not task completion");
});

test("oracle catches model false completion and incorrect actions without depending on its status", async () => {
  const scenario = generateScenarios({ mechanisms: ["fresh_ids"] })[0]!;
  const falseResult = await runScenario(scenario, { fixturePolicy: () => undefined });
  assert.equal(falseResult.agentStatus, "completed");
  assert.equal(falseResult.verdict, "failed");
  assert.equal(falseResult.falseCompletion, true);
  const wrong = await runScenario(scenario, { fixturePolicy: (tree, body, s) => {
    const decoy = tree?.nodes.find((n: any) => (n.desc ?? n.text) === "其他项目");
    return decoy ? { name: "act_and_observe", arguments: { action: "tap_element", arguments: { snapshotId: tree!.snapshotId, nodeId: decoy.nodeId } } } : observedPolicy(tree, body, s);
  } });
  assert.equal(wrong.verdict, "failed");
  assert.equal(wrong.wrongActions, 1);
  assert.equal(judge(scenario, undefined), "unknown");
});

test("state machine permits native click or touch and has no expected action sequence", async () => {
  const scenario = generateScenarios({ mechanisms: ["clickable_parent"] })[0]!;
  const result = await runScenario(scenario, { fixturePolicy: (tree, body, s) => {
    const choice = observedPolicy(tree, body, s);
    if (choice?.arguments.action === "tap_element") choice.arguments.action = "click_element";
    return choice;
  } });
  assert.equal(result.verdict, "goal");
  assert.equal(result.mutations, 1);
  const phone = new ScenarioPhone(scenario);
  assert.equal(judge(scenario, phone.state), "failed");
});
