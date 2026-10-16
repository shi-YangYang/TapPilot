import { connect } from "node:net";
import type { ApprovalPrompt } from "../src/approvals.js";

/** Synthetic test-only human channel; never used against a live user's server. */
export function approvalCommand(socketPath: string, value: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("error", reject);
    socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) { socket.destroy(); resolve(JSON.parse(data)); } });
  });
}

export async function grant(prompt: ApprovalPrompt): Promise<Record<string, any>> {
  const inspected = await approvalCommand(prompt.socketPath, { op: "inspect", approvalId: prompt.approvalId });
  const result = await approvalCommand(prompt.socketPath, { op: "approve", approvalId: prompt.approvalId, challenge: inspected.challenge });
  if (result.ok !== true) throw new Error("Test approval failed");
  return inspected;
}

export const snapshot = {
  snapshotId: "session:1", revision: 1, windowId: 4, packageName: "com.android.settings", truncated: false,
  nodes: [{ nodeId: "n0", parentId: null, text: "电池", contentDescription: "Battery", resourceId: "android:id/title", className: "android.widget.TextView", bounds: [0, 50, 300, 100], clickable: true, scrollable: false, editable: false, enabled: true, password: false }],
};
