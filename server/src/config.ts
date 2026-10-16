import { AgentError } from "./errors.js";

export type ApprovalMode = "manual" | "trusted";

export interface RuntimeConfig {
  approvalMode: ApprovalMode;
  serial?: string;
  adbPath?: string;
  allowEmulator: boolean;
}

/** Authorization is selected by the owner's startup configuration, never by tool arguments. */
export function readRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const approvalMode = env.TAPPILOT_APPROVAL_MODE ?? "manual";
  if (approvalMode !== "manual" && approvalMode !== "trusted") {
    throw new AgentError("INVALID_CONFIGURATION", "TAPPILOT_APPROVAL_MODE must be manual or trusted.");
  }
  const serial = env.TAPPILOT_SERIAL?.trim() || undefined;
  if (approvalMode === "trusted" && !serial) {
    throw new AgentError("INVALID_CONFIGURATION", "Trusted authorization requires TAPPILOT_SERIAL to identify the owner's device.");
  }
  return { approvalMode, serial, adbPath: env.ADB_PATH, allowEmulator: env.TAPPILOT_ALLOW_EMULATOR === "1" };
}
