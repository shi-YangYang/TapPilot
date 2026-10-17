// Reproducible synthetic Android fixtures. This module has no model, device, or oracle access.
const scenes = new Set(['navigation', 'search', 'async_list', 'ime', 'overlay', 'long_list', 'webview', 'canvas']);
const packageName = 'dev.tappilot.testbed';

function randomFor(scene, seed, split) {
  let state = 2166136261;
  for (const letter of `testbed-v1:${split}:${scene}:${seed}`) {
    state ^= letter.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Oracle keys keep their business meanings; labels, geometry, and timings vary independently. */
export function generateCase(definition, seed, { split = 'regression' } = {}) {
  const scene = definition?.id;
  if (!scenes.has(scene)) throw new Error('UNKNOWN_FIXTURE');
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new Error('INVALID_SEED');
  if (!['regression', 'holdout'].includes(split)) throw new Error('INVALID_SPLIT');
  const random = randomFor(scene, seed, split);
  const integer = (from, to) => from + Math.floor(random() * (to - from + 1));
  const pick = values => values[integer(0, values.length - 1)];
  // An explicit regression anchor makes the default corpus contain both a baseline and disturbances.
  // Holdout uses an independent salt and does not inherit this special case.
  const baseline = split === 'regression' && seed === 17;
  const suffix = `${integer(10, 99)}${seed % 997}`;
  const labels = {
    target: `合成目标${suffix}`, decoy: `合成目标${suffix}0`, open: `打开目录${suffix}`,
    search: `查找${suffix}`, save: `${scene === 'webview' ? '保存网页内容' : '保存草稿'}${suffix}`,
    dismiss: `关闭浮层${suffix}`, input: `合成输入${suffix}`, recipient: `合成会话甲${suffix}`,
  };
  if (scene === 'search') labels.input = labels.target;
  const variant = {
    schemaVersion: 1, id: `v1-${scene}-${seed}-${split}`, scene, seed, labels,
    layout: baseline ? 'plain' : pick(['parent_label', 'compact']),
    targetIndex: baseline ? 2 : integer(1, 4), itemCount: 4,
    delayMs: baseline ? 0 : pick([160, 400, 900, 1200]),
    refreshMs: 1200, refreshCount: 0, refreshMode: 'none', reverse: !baseline && random() >= 0.5,
  };
  const coverage = [];
  const layoutCoverage = () => {
    coverage.push(`layout_${variant.layout}`);
  };
  const orderCoverage = () => {
    coverage.push('variable_target_position', 'similar_label_distractors');
    if (variant.reverse) coverage.push('reversed_order');
  };
  const delayCoverage = tag => { if (variant.delayMs > 0) coverage.push(tag); };
  let task;
  switch (scene) {
    case 'navigation':
      variant.itemCount = baseline ? 3 : integer(4, 7);
      variant.targetIndex = baseline ? 2 : integer(1, variant.itemCount);
      task = `在当前合成测试页面点击“${labels.open}”，进入目录后打开“${labels.target}”，读取显示的信息后结束。不要打开名字相近的其他项目。`;
      coverage.push('variable_target_label', 'multiple_pages'); layoutCoverage(); orderCoverage(); delayCoverage('delayed_content');
      break;
    case 'search':
      variant.itemCount = baseline ? 3 : integer(4, 7);
      variant.targetIndex = baseline ? 2 : integer(1, variant.itemCount);
      task = `在当前合成搜索页面输入“${labels.input}”，点击“${labels.search}”，然后打开“查看${labels.target}”这个精确匹配结果后结束。`;
      coverage.push('variable_target_label', 'variable_input', 'search_results'); layoutCoverage(); orderCoverage(); delayCoverage('delayed_content');
      break;
    case 'async_list':
      variant.itemCount = baseline ? 3 : integer(3, 5);
      variant.targetIndex = baseline ? 2 : integer(1, variant.itemCount);
      variant.refreshMode = baseline ? 'none' : seed === 29 && split === 'regression' ? 'peer_text'
        : seed === 43 && split === 'regression' ? 'replace' : pick(['peer_text', 'replace', 'reorder']);
      variant.refreshCount = baseline ? 0 : 300;
      variant.refreshMs = baseline ? 1200 : pick([900, 1200]);
      task = `在当前会刷新的合成列表中，找到并打开“${labels.target}”后结束。其他名称相近的项目不是目标。`;
      coverage.push('variable_target_label', 'native_list');
      // Both plain and parent_label list rows are real clickable parent rows; only compact alters height.
      coverage.push('parent_clickable_label', variant.layout === 'compact' ? 'compact_rows' : 'regular_rows');
      orderCoverage(); delayCoverage('delayed_content');
      if (variant.refreshMode !== 'none') coverage.push(`async_${variant.refreshMode}`);
      break;
    case 'ime':
      variant.itemCount = 3; variant.targetIndex = 2; variant.reverse = false;
      variant.refreshMode = baseline ? 'none' : 'peer_text';
      variant.refreshCount = baseline ? 0 : 300;
      variant.refreshMs = baseline ? 1200 : pick([900, 1200]);
      task = `在当前“${labels.recipient}”会话的草稿框输入“${labels.input}”，点击“${labels.save}”后结束。不要切换会话。这是本地合成测试草稿，不发送消息。`;
      coverage.push('variable_input', 'recipient_context', 'keyboard_focus'); layoutCoverage(); delayCoverage('delayed_save');
      if (variant.refreshMode !== 'none') coverage.push('refreshing_form_text');
      break;
    case 'overlay':
      variant.itemCount = 3; variant.targetIndex = 2; variant.reverse = false;
      task = `关闭当前合成遮挡浮层（按钮“${labels.dismiss}”），然后打开下方的“${labels.target}”后结束。`;
      coverage.push('variable_target_label', 'variable_dismiss_label', 'modal_overlay', 'similar_label_distractors'); layoutCoverage(); delayCoverage('delayed_modal');
      break;
    case 'long_list': {
      variant.itemCount = baseline ? 24 : integer(35, 70);
      // Select an actual display position below the first viewport, including reversed ordering.
      const displayPosition = baseline ? 18 : integer(20, variant.itemCount);
      variant.targetIndex = variant.reverse ? variant.itemCount - displayPosition + 1 : displayPosition;
      task = `在当前合成长列表中找到“${labels.target}”，打开其详细页面后结束。请根据界面滚动查找，不要选择名字相近的项目。`;
      coverage.push('variable_target_label', 'native_list', 'offscreen_target'); layoutCoverage(); orderCoverage(); delayCoverage('delayed_content');
      break;
    }
    case 'webview':
      variant.itemCount = 3; variant.targetIndex = 2;
      task = `在当前合成网页表单输入“${labels.input}”，点击“${labels.save}”保存后结束，不要点击“${labels.decoy}”。`;
      coverage.push('variable_input', 'local_webview', 'similar_label_distractors'); layoutCoverage(); delayCoverage('delayed_content');
      if (variant.reverse) coverage.push('reversed_button_order');
      break;
    case 'canvas':
      variant.itemCount = 5; variant.targetIndex = baseline ? 2 : integer(1, 5);
      variant.delayMs = 0;
      task = '查看当前合成测试画面，点击蓝色圆形按钮后结束。如果工具无法读取其位置，请明确说明无法完成，不要猜坐标。';
      // target/open/input labels are unused by this view and must not inflate coverage.
      coverage.push('inaccessible_canvas', 'canvas_position', variant.layout === 'compact' ? 'small_canvas_target' : 'regular_canvas_target');
      break;
  }
  return { ...definition, initial: { ...definition.initial }, expected: { ...definition.expected }, seed,
    variantId: variant.id, variant, task, expectedOutcome: scene === 'canvas' ? 'unavailable' : 'complete', coverage };
}

/** Only parameters that change this Android view participate in diversity counts. */
export function effectiveVariant(scenario) {
  const v = scenario?.variant;
  if (!v || !scenes.has(scenario.id) || v.scene !== scenario.id) throw new Error('UNKNOWN_FIXTURE');
  const named = (...keys) => Object.fromEntries(keys.map(key => [key, v.labels[key]]));
  const ordered = () => ({ itemCount: v.itemCount, targetIndex: v.targetIndex, reverse: v.reverse });
  const refresh = () => v.refreshMode === 'none' || v.refreshCount === 0 ? { mode: 'none' } : {
    mode: scenario.id === 'ime' ? 'peer_text' : v.refreshMode,
    intervalMs: v.refreshMs, count: v.refreshCount,
    ...(v.refreshMode === 'reorder' && scenario.id === 'async_list' ? { reorderSeed: v.seed } : {}),
  };
  const base = { scene: scenario.id };
  switch (scenario.id) {
    case 'navigation':
      return { ...base, labels: named('target', 'decoy', 'open'), layout: v.layout, ...ordered(), delayMs: v.delayMs };
    case 'search':
      return { ...base, labels: named('target', 'decoy', 'input', 'search'), layout: v.layout, ...ordered(), delayMs: v.delayMs };
    case 'async_list':
      return { ...base, labels: named('target', 'decoy'), layout: v.layout === 'compact' ? 'compact' : 'parent_row',
        ...ordered(), delayMs: v.delayMs, refresh: refresh() };
    case 'ime':
      return { ...base, labels: named('recipient', 'decoy', 'input', 'save'), layout: v.layout, delayMs: v.delayMs, refresh: refresh() };
    case 'overlay':
      return { ...base, labels: named('target', 'decoy', 'dismiss'), layout: v.layout, delayMs: v.delayMs };
    case 'long_list':
      return { ...base, labels: named('target', 'decoy'), layout: v.layout, ...ordered(), delayMs: v.delayMs };
    case 'webview':
      return { ...base, labels: named('target', 'decoy', 'input', 'save'), layout: v.layout === 'compact' ? 'compact' : 'regular',
        reverse: v.reverse, delayMs: v.delayMs };
    case 'canvas':
      return { ...base, horizontal: v.reverse ? 0.68 : 0.32,
        vertical: 0.3 + 0.4 * (v.targetIndex - 1) / (v.itemCount - 1), radiusDp: v.layout === 'compact' ? 48 : 64 };
  }
}

/** This counts generated effective configurations, not successful or observed test coverage. */
export function summarizeVariantDiversity(scenarios) {
  const all = new Set();
  const byScene = {};
  for (const scenario of scenarios) {
    const key = JSON.stringify(effectiveVariant(scenario));
    all.add(key);
    const entry = byScene[scenario.id] ??= { cases: 0, keys: new Set() };
    entry.cases++;
    entry.keys.add(key);
  }
  return { totalCases: scenarios.length, uniqueEffectiveCases: all.size, duplicateCases: scenarios.length - all.size,
    byScene: Object.fromEntries(Object.entries(byScene).map(([id, value]) => [id, {
      cases: value.cases, uniqueEffectiveCases: value.keys.size, duplicateCases: value.cases - value.keys.size,
    }])) };
}

/** Deterministic control policy reads only observed UI and public task labels, never oracle state. */
export function chooseVariantAction(scenario, tree) {
  if (!scenario?.variant || !scenes.has(scenario.id)) throw new Error('UNKNOWN_FIXTURE');
  if (!tree || tree.packageName !== packageName || !Array.isArray(tree.nodes)) throw new Error('FIXTURE_UI_MISSING');
  const nodes = tree.nodes.filter(node => node.visible !== false && node.enabled !== false);
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const labels = scenario.variant.labels;
  const has = text => nodes.some(node => node.text === text);
  const resource = node => (node.rid ?? node.resourceId ?? '').replace(`${packageName}:`, '');
  const target = node => ({ snapshotId: tree.snapshotId, nodeId: node.nodeId });
  const wait = selector => ({ tool: 'wait_for_ui_change', arguments: {
    sinceRevision: tree.revision, timeoutMs: 1500, ...(selector ? { selector } : {}),
  } });
  const clickableAncestor = node => {
    const visited = new Set();
    while (node && !visited.has(node.nodeId)) {
      visited.add(node.nodeId);
      if (node.clickable === true) return node;
      node = byId.get(node.parentId);
    }
    return undefined;
  };
  const findTap = (text, rid) => {
    const candidates = new Map();
    for (const node of nodes.filter(node => node.text === text || (node.desc ?? node.contentDescription) === text)) {
      const actual = clickableAncestor(node);
      if (actual && (!rid || resource(actual) === rid || resource(node) === rid)) candidates.set(actual.nodeId, actual);
    }
    if (candidates.size > 1) throw new Error('FIXTURE_TARGET_AMBIGUOUS');
    const node = [...candidates.values()][0];
    return node ? { action: 'tap_element', arguments: target(node) } : undefined;
  };
  const editor = rid => {
    const candidates = nodes.filter(node => node.editable === true && (!rid || resource(node) === rid));
    if (candidates.length > 1) throw new Error('FIXTURE_TARGET_AMBIGUOUS');
    return candidates[0];
  };
  const input = node => ({ action: 'input_text', arguments: { ...target(node), text: labels.input } });
  const scrollOrWait = () => {
    const candidates = nodes.filter(node => node.scrollable === true);
    if (candidates.length > 1) throw new Error('FIXTURE_TARGET_AMBIGUOUS');
    return candidates.length === 1 ? { action: 'scroll', arguments: { ...target(candidates[0]), direction: 'forward' } } : wait();
  };
  if (has('合成任务已完成')) return null;
  switch (scenario.id) {
    case 'navigation':
      return findTap(labels.open, 'id/navigation_open') ?? findTap(labels.target, 'id/navigation_target') ?? scrollOrWait();
    case 'search': {
      const field = editor('id/search_input');
      if (field) return field.text === labels.input ? findTap(labels.search, 'id/search_go') ?? wait() : input(field);
      return findTap(`查看${labels.target}`, 'id/search_result') ?? scrollOrWait();
    }
    case 'async_list':
      return findTap(labels.target, 'id/async_target') ?? scrollOrWait();
    case 'ime': {
      if (!has(labels.recipient)) throw new Error('FIXTURE_RECIPIENT_CHANGED');
      const field = editor('id/ime_input');
      if (!field) return wait({ editable: true });
      if (field.focused !== true) return findTap('打开键盘', 'id/ime_focus') ?? scrollOrWait();
      return field.text === labels.input ? findTap(labels.save, 'id/ime_save') ?? scrollOrWait() : input(field);
    }
    case 'overlay':
      return findTap(labels.dismiss) ?? findTap(labels.target, 'id/overlay_target') ?? wait();
    case 'long_list':
      return findTap(labels.target, 'id/long_target') ?? scrollOrWait();
    case 'webview': {
      const field = editor();
      if (!field) return wait({ editable: true });
      return field.text === labels.input ? findTap(labels.save) ?? scrollOrWait() : input(field);
    }
    case 'canvas':
      return null; // Production client has no visual action tool. Never infer coordinates from configuration.
    default:
      throw new Error('UNKNOWN_FIXTURE');
  }
}
