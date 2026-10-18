// Protocol facts only. Never classify or display native exception/UI prose.
export const screenshotFailureReasons = ["WINDOW_OBSCURED", "SYSTEM_SECURE_WINDOW", "SCREENSHOT_ACCESS_DENIED",
  "SENSITIVE_NODE", "SENSITIVE_SCAN_LIMIT", "UNSUPPORTED_WINDOW"] as const;
export type ScreenshotFailureReason = typeof screenshotFailureReasons[number];

export function isScreenshotReasonPair(code: unknown, reason: unknown): reason is ScreenshotFailureReason {
  return code === "SCREENSHOT_PROTECTED" && screenshotFailureReasons.includes(reason as ScreenshotFailureReason) ||
    code === "SCREENSHOT_UNAVAILABLE" && reason === "SCREENSHOT_ACCESS_DENIED" ||
    code === "SENSITIVE_FIELD" && reason === "SENSITIVE_NODE";
}

export function screenshotFailureReason(error: unknown): ScreenshotFailureReason | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return;
  const value = error as Record<string, unknown>;
  const details = value.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return;
  const fields = details as Record<string, unknown>;
  if (Object.keys(fields).length === 1 && isScreenshotReasonPair(value.code, fields.reason)) return fields.reason;
}

/** Fixed descriptions are shared by automatic capture and nested visual observations. */
export function screenshotFailureMessage(code: unknown, reason?: unknown): string {
  if (isScreenshotReasonPair(code, reason)) {
    const messages: Record<ScreenshotFailureReason, string> = {
      WINDOW_OBSCURED: "其他窗口遮挡了当前页面，无法完成截图观察。请关闭悬浮窗或切回目标应用。",
      SYSTEM_SECURE_WINDOW: "Android 将当前窗口标记为禁止截图，请在手机上手动完成当前步骤。",
      SCREENSHOT_ACCESS_DENIED: "Android 拒绝了截图访问，请检查 TapPilot 无障碍服务是否正常连接。",
      SENSITIVE_NODE: "当前页面含密码或敏感控件，已停止截图，请在手机上手动完成当前步骤。",
      SENSITIVE_SCAN_LIMIT: "无法完整确认当前页面是否含敏感控件，已停止截图，请在手机上手动完成当前步骤。",
      UNSUPPORTED_WINDOW: "当前窗口类型不支持截图观察，请切回普通应用页面。",
    };
    return messages[reason];
  }
  const messages: Record<string, string> = {
    SCREENSHOT_PROTECTED: "手机端限制了当前页面的截图，但未提供具体原因，请查看手机当前页面。",
    SCREENSHOT_TIMEOUT: "截图请求超时，未取得当前页面图片，请查看手机状态。",
    SCREENSHOT_RATE_LIMITED: "截图请求过于频繁，请稍后重新开始任务。",
    SCREENSHOT_CONTEXT_CHANGED: "截图期间页面已切换，图片已丢弃，请确认目标页面后重新开始。",
    SCREENSHOT_UNSUPPORTED: "此手机暂不支持截图观察，请在手机上手动完成当前步骤。",
    SCREENSHOT_FAILED: "Android 未能生成截图，请查看手机当前状态。",
    SCREENSHOT_UNAVAILABLE: "当前无法取得截图，请检查手机端是否正常连接。",
    SCREENSHOT_SENSITIVE: "当前页面包含敏感内容，已停止截图，请在手机上手动完成当前步骤。",
    SENSITIVE_FIELD: "当前页面含敏感输入，已停止截图，请在手机上手动完成当前步骤。",
    PASSWORD_FIELD_BLOCKED: "当前页面含密码输入，已停止截图，请在手机上手动完成当前步骤。",
    PROTECTED_APP: "当前应用受保护，请在手机上手动完成当前步骤。",
    DEVICE_LOCKED: "手机已锁屏，请由你本人解锁后重新开始任务。",
    SERVICE_UNAVAILABLE: "TapPilot 无障碍服务未连接，请在手机上检查服务状态。",
    EMERGENCY_STOPPED: "手机已停止自动化，请在手机上确认是否恢复控制。",
  };
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code]! : "截图观察未完成，请查看手机当前状态。";
}
