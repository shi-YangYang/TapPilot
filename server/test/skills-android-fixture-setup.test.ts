import assert from "node:assert/strict";
import test from "node:test";
import { armAndroidSafetyFixture } from "../src/skills/android-fixture-setup.js";

const tree = (suffix: string) => ({ packageName: "dev.tappilot.testbed", snapshotId: suffix, truncated: false, nodes: [
  { nodeId: `arm-${suffix}`, resourceId: "dev.tappilot.testbed:id/native_arm" },
  { nodeId: `status-${suffix}`, resourceId: "dev.tappilot.testbed:id/native_status", text: "同步进度：42" },
] });
function setup(responses: Record<string, any>[], armWorks = true, changeWorks = true) {
  const state = { armed: false, changed: false, completed: false, wrongClicks: 0, wrongInputs: 0, firstInput: "empty", secondInput: "empty" };
  const calls: Record<string, any>[] = [];
  return { state, calls, initial: tree("old"), read: async () => tree("new"), oracle: async () => ({ ...state }),
    pause: async () => { if (state.armed && changeWorks) state.changed = true; },
    execute: async (args: Record<string, any>) => {
      calls.push(args); const response = responses.shift()!;
      if (response.ok && armWorks) state.armed = true;
      return response;
    },
  };
}
const refused = { ok: false, meta: { nativeExecutorRefusal: true }, error: { code: "TARGET_CHANGED",
  details: { executor: "node-v1", dispatchState: "not_sent", reason: "PAGE_CONTEXT_CHANGED" } } };
const accepted = { ok: true, result: { observation: tree("accepted") } };

test("fixture setup resolves fresh IDs only after verified not-sent refusal and proves the counterexample occurred", async () => {
  const io = setup([refused, accepted]);
  assert.equal((await armAndroidSafetyFixture(io)).snapshotId, "accepted");
  assert.equal(io.state.changed, true);
  assert.deepEqual(io.calls.map(c => c.arguments.nodeId), ["arm-old", "arm-new"]);
  assert.deepEqual(io.calls[1]!.arguments.allowedLabelChanges, ["status-new"]);
});

test("fixture setup does not replay unknown dispatch, untrusted refusal or already armed state", async () => {
  for (const response of [{ ...refused, meta: {} }, { ...refused, error: { ...refused.error, details: { ...refused.error.details, dispatchState: "unknown" } } }]) {
    const io = setup([response, accepted]);
    await assert.rejects(armAndroidSafetyFixture(io), { code: "SKILLS_ANDROID_ENVIRONMENT" });
    assert.equal(io.calls.length, 1);
  }
  const io = setup([accepted]); io.state.armed = true;
  await assert.rejects(armAndroidSafetyFixture(io), { code: "SKILLS_ANDROID_ENVIRONMENT" });
  assert.equal(io.calls.length, 0);
});

test("accepted touch and missing scheduled change cannot count as prepared safety evidence", async () => {
  for (const [armWorks, changeWorks] of [[false, true], [true, false]]) {
    const io = setup([accepted], armWorks, changeWorks);
    await assert.rejects(armAndroidSafetyFixture(io), { code: "SKILLS_ANDROID_ENVIRONMENT" });
    assert.equal(io.calls.length, 1);
  }
  const io = setup([refused, refused, refused, accepted]);
  await assert.rejects(armAndroidSafetyFixture(io), { code: "SKILLS_ANDROID_ENVIRONMENT" });
  assert.equal(io.calls.length, 3);
});
