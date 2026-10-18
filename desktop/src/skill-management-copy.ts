import type { SkillOperation, SkillPredicate, SkillScope, SkillSpec, SkillTrigger } from '../../server/src/skills/schema';

export const skillStateLabels = {
  draft: '待验证', candidate: '验证中', active: '已生效', superseded: '已替换', revoked: '已撤回', rejected: '未通过',
} as const;
export const actionLabels: Record<string, string> = {
  none: '无操作', unknown: '其他操作', get_device_info: '读取设备', get_current_app: '读取应用', get_ui_tree: '读取界面', find_element: '查找目标', observe_target: '查看目标',
  wait_for_ui_change: '等待界面', take_screenshot: '查看截图', tap_element: '点按目标', tap_visual: '看图点按', swipe_visual: '看图滑动', click_element: '点击控件', input_text: '输入文字',
  scroll: '滚动页面', swipe: '滑动屏幕', press_key: '系统导航', open_settings: '打开设置',
};
export const errorLabels: Record<string, string> = {
  TARGET_CHANGED: '目标内容变化', STALE_SNAPSHOT: '界面已更新', NODE_NOT_ACTIONABLE: '目标无法操作', NODE_NOT_FOUND: '未找到目标',
  NODE_DISABLED: '目标不可用', NODE_NOT_VISIBLE: '目标不可见', ACTION_NOT_COMPLETED: '操作未完成', PAGE_CONTEXT_UNSTABLE: '页面持续变化',
  UI_OBSERVATION_UNAVAILABLE: '界面信息不足',
  VISUAL_REFERENCE_INVALID: '截图已失效', VISUAL_REFERENCE_EXPIRED: '截图已过期',
  VISUAL_CONTEXT_CHANGED: '页面已切换', VISUAL_SCENE_CHANGED: '画面已变化', VISUAL_TARGET_UNSAFE: '目标需手动操作',
  VISUAL_ACTION_UNSUPPORTED: '不支持看图点按', VISUAL_ACTION_UNAVAILABLE: '缺少可点按截图',
  VISUAL_NO_PROGRESS: '点按后未确认进展', VISUAL_OBSERVATION_FAILED: '点按后观察失败',
  NO_OBSERVATION: '缺少界面信息', TRUNCATED_SNAPSHOT: '界面信息不完整', NONE: '无错误', UNKNOWN: '其他错误',
};
export const reasonLabels: Record<string, string> = {
  PAGE_CONTEXT_CHANGED: '页面内容变化', NODE_CONTENT_CHANGED: '控件内容变化', NODE_STATE_CHANGED: '控件状态变化',
  TREE_STRUCTURE_CHANGED: '界面结构变化', TARGET_IDENTITY_CHANGED: '目标身份变化', TARGET_AMBIGUOUS: '目标不唯一',
  TARGET_NOT_ACTIONABLE: '目标无法操作', NO_CLICKABLE_TARGET: '没有可点击控件', AMBIGUOUS_TOUCH_TARGET: '触控区域重叠',
  TOUCH_TARGET_MISMATCH: '触控位置不一致', SNAPSHOT_MISSING: '缺少界面信息', INCOMPLETE_TREE: '界面信息不完整',
  TARGET_DISABLED: '目标不可用', TARGET_HIDDEN: '目标不可见', NONE: '无附加原因', UNKNOWN: '其他原因',
};
export const operationLabels: Record<SkillOperation['op'], string> = {
  observe: '读取界面', wait: '等待界面变化', resolve_target: '重新定位目标', inspect: '检查界面', inspect_changed_labels: '检查变化的文字',
  allow_unrelated_status_labels: '核对无关状态文字', focus_existing_input: '聚焦当前输入框', input_requested_text: '输入任务要求的文字',
  activate_resolved_target: '点按已定位目标', scroll_resolved_container: '滚动已定位区域', verify_effect: '验证操作结果', discard_stale_target: '丢弃旧目标',
};
export const observeLabels = { reuse_latest: '使用最新界面', refresh_if_missing: '缺少信息时刷新', refresh_if_incomplete: '信息不完整时刷新' } as const;
export const capabilityLabels = { clickable: '可点击控件', editable: '输入框', scrollable: '可滚动区域' } as const;
export const aspectLabels = { hierarchy: '控件层级', focus_and_ime: '输入焦点与键盘', overlap: '遮挡与重叠', context: '页面与任务上下文' } as const;
export const evidenceLabels = { current_observation: '当前界面', focused_input: '输入焦点', target_state: '目标状态' } as const;
const factLabels: Record<string, string> = {
  nodeCount: '控件数量', actionableCount: '可操作控件数量', editableCount: '输入框数量', scrollableCount: '滚动区域数量', focusedCount: '焦点数量', changedLabelCount: '变化文字数量',
  hasObservation: '已有界面信息', complete: '界面信息完整', focusPresent: '存在焦点', imeVisible: '键盘可见', structureChanged: '界面结构变化', contextChanged: '页面上下文变化',
  focusChanged: '焦点变化', imeChanged: '键盘变化', priorActionAccepted: '上次操作已受理', priorEffectUnknown: '上次操作结果未知', targetPresent: '目标存在',
  targetClickable: '目标可点击', targetEditable: '目标可输入', targetScrollable: '目标可滚动', targetAncestorClickable: '上层控件可点击', targetVisible: '目标可见',
  targetEnabled: '目标可用', targetFocused: '目标已有焦点', changedLabelsPresent: '有文字变化记录', nativeContextChange: '执行器发现内容变化', labelOnlyContextChange: '只有文字变化', observedLabelChanges: '已观察到文字变化',
};
export function predicateText(predicate: SkillPredicate): string {
  const value = typeof predicate.value === 'boolean' ? (predicate.value ? '是' : '否') : ({ yes: '是', no: '否', unknown: '未知' } as Record<string, string>)[predicate.value] ?? predicate.value;
  return `${factLabels[predicate.fact] || predicate.fact} ${predicate.test === 'gte' ? '≥' : predicate.test === 'lte' ? '≤' : '＝'} ${value}`;
}
export function operationText(operation: SkillOperation): string {
  const detail = operation.op === 'observe' ? observeLabels[operation.mode] : operation.op === 'wait' ? `${operation.timeoutMs / 1000} 秒` :
    operation.op === 'resolve_target' ? `${capabilityLabels[operation.capability]} · 向上检查 ${operation.maxAncestorHops} 层` : operation.op === 'inspect' ? aspectLabels[operation.aspect] :
    operation.op === 'scroll_resolved_container' ? operation.direction === 'forward' ? '向前一次' : '向后一次' : operation.op === 'verify_effect' ? evidenceLabels[operation.evidence] : '';
  return operationLabels[operation.op] + (detail ? ` · ${detail}` : '');
}
export function defaultOperation(op: SkillOperation['op']): SkillOperation {
  switch (op) {
    case 'observe': return { op, mode: 'refresh_if_incomplete' };
    case 'wait': return { op, timeoutMs: 500 };
    case 'resolve_target': return { op, capability: 'clickable', maxAncestorHops: 1 };
    case 'inspect': return { op, aspect: 'hierarchy' };
    case 'input_requested_text': return { op, source: 'current_task_requested_text' };
    case 'activate_resolved_target': return { op, target: 'current_task_target' };
    case 'scroll_resolved_container': return { op, direction: 'forward', count: 1 };
    case 'verify_effect': return { op, evidence: 'current_observation' };
    default: return { op };
  }
}
export function newSkillSpec(scope: SkillScope): SkillSpec {
  return {
    schemaVersion: 1, scope, trigger: { errorCode: 'TARGET_CHANGED', reason: 'PAGE_CONTEXT_CHANGED', actionKind: 'tap_element' },
    entryConditions: [{ fact: 'priorEffectUnknown', test: 'eq', value: 'no' }],
    program: { entry: 0, nodes: [
      { kind: 'step', operation: { op: 'observe', mode: 'refresh_if_incomplete' }, next: 1 },
      { kind: 'step', operation: { op: 'discard_stale_target' }, next: 2 },
      { kind: 'step', operation: { op: 'resolve_target', capability: 'clickable', maxAncestorHops: 1 }, next: 3 },
      { kind: 'end', outcome: 'continue' },
    ] },
    lineage: { negativeFeedback: [] }, basis: 'hypothesis', expiresAt: Date.now() + 30 * 86_400_000,
  };
}
export function triggerText(trigger: SkillTrigger): string {
  return `${actionLabels[trigger.actionKind] || trigger.actionKind} · ${errorLabels[trigger.errorCode] || trigger.errorCode}`;
}
/** Only sequential programs can use the simple step editor. Preserve every
 * condition, branch, prevention procedure and lineage field otherwise. */
export function isLinearProgram(program: SkillSpec['program']): boolean {
  return program.nodes.every((node, index) => index === program.nodes.length - 1 ? node.kind === 'end' : node.kind === 'step' && node.next === index + 1);
}

export function displaySkillTitle(item: { title: string; source: 'manual' | 'automatic'; spec: SkillSpec }): string {
  return item.source === 'automatic' && item.title === `${item.spec.trigger.errorCode} · ${item.spec.trigger.actionKind}`
    ? triggerText(item.spec.trigger) : item.title;
}
