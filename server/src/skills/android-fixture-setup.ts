import { RuntimeError } from "../runtime/model.js";
import { fullObservation } from "../runtime/context.js";

type Json = Record<string, any>;
type Setup = {
  initial: Json;
  read: () => Promise<Json>;
  execute: (args: Json) => Promise<Json>;
  oracle: () => Promise<Json>;
  pause: () => Promise<void>;
};
const fail = (): never => { throw new RuntimeError("SKILLS_ANDROID_ENVIRONMENT", "SKILLS_ANDROID_ENVIRONMENT"); };
const untouched = (state: Json) => state.completed === false && state.wrongClicks === 0 && state.wrongInputs === 0
  && state.firstInput === "empty" && state.secondInput === "empty";
const complete = (tree: Json | undefined): tree is Json => tree?.packageName === "dev.tappilot.testbed"
  && tree.truncated === false && typeof tree.snapshotId === "string" && Array.isArray(tree.nodes);

/** Synthetic fixture setup only. Never replay a dispatched or ambiguous action.
 * Native refusal proof plus independent untouched app state permits at most two
 * fresh resolutions. The oracle must prove the safety counterexample happened. */
export async function armAndroidSafetyFixture(setup: Setup): Promise<Json> {
  let tree = setup.initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await setup.oracle();
    if (!untouched(before) || before.armed === true || before.changed === true || !complete(tree)) fail();
    const arm = tree.nodes.find((n: Json) => n.resourceId?.endsWith("/native_arm"));
    const status = tree.nodes.find((n: Json) => n.resourceId?.endsWith("/native_status") && !n.clickable && !n.editable
      && /^(同步进度|合成动态内容)：\d+$/.test(n.text ?? ""));
    if (!arm || !status) fail();
    const response = await setup.execute({ action: "tap_element", arguments: { snapshotId: tree.snapshotId, nodeId: arm.nodeId,
      allowedLabelChanges: [status.nodeId] } });
    const after = await setup.oracle();
    if (!untouched(after)) fail();
    if (response.ok === true) {
      // A touch can be accepted without delivering the fixture's click handler.
      if (after.armed !== true) fail();
      const observation = fullObservation(response) as Json | undefined;
      if (!complete(observation)) return fail();
      for (let poll = 0; poll < 20; poll++) {
        const state = await setup.oracle();
        if (!untouched(state) || state.armed !== true) fail();
        if (state.changed === true) return observation;
        await setup.pause();
      }
      fail();
    }
    const details = response.error?.details;
    if (attempt === 2 || response.meta?.nativeExecutorRefusal !== true || details?.executor !== "node-v1"
      || details.dispatchState !== "not_sent" || !["TARGET_CHANGED", "STALE_SNAPSHOT", "NODE_NOT_FOUND"].includes(response.error?.code)
      || after.armed === true || after.changed === true) fail();
    await setup.pause();
    tree = await setup.read();
  }
  return fail();
}
