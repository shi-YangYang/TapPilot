const packageName = 'dev.tappilot.testbed';
function latestObservation(body) {
  const found = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.snapshotId === 'string' && Array.isArray(value.nodes)) found.push(value);
    else for (const nested of Object.values(value)) visit(nested);
  }
  for (const message of body.messages ?? []) if (message.role === 'tool' && message.content) {
    try { visit(JSON.parse(message.content)); } catch { /* Non-JSON host messages carry no observation. */ }
  }
  return found.at(-1);
}

/** Deterministic fixture policy reads the production model projection, never expected oracle state. */
export function chooseFixtureAction(scene, tree) {
  if (!tree || tree.packageName !== packageName) throw new Error('FIXTURE_UI_MISSING');
  const nodes = tree.nodes.filter(node => node.visible !== false && node.enabled !== false);
  const has = text => nodes.some(node => node.text === text);
  const by = (test, capability) => {
    const candidates = nodes.filter(node => test(node) && (!capability || node[capability] === true));
    if (candidates.length !== 1) throw new Error('FIXTURE_TARGET_AMBIGUOUS');
    return candidates[0];
  };
  const target = node => ({ snapshotId: tree.snapshotId, nodeId: node.nodeId });
  const tap = text => ({ action: 'tap_element', arguments: target(by(node => node.text === text, 'clickable')) });
  const input = (node, text) => ({ action: 'input_text', arguments: { ...target(node), text } });
  if (scene === 'navigation') {
    if (has('合成电池电量：73%')) return null;
    return tap(has('打开测试目录') ? '打开测试目录' : '合成电池');
  }
  if (scene === 'search') {
    if (has('合成商品：电池，价格 42 元')) return null;
    if (has('查看合成电池')) return tap('查看合成电池');
    const editor = by(node => node.rid === 'id/search_input', 'editable');
    return editor.text === '合成电池' ? tap('搜索') : input(editor, '合成电池');
  }
  if (scene === 'async_list') return has('已打开合成目标 B') ? null : tap('合成目标 B');
  if (scene === 'ime') {
    if (has('合成草稿已保存')) return null;
    if (!has('合成会话甲')) throw new Error('FIXTURE_RECIPIENT_CHANGED');
    const editor = by(node => node.rid === 'id/ime_input', 'editable');
    if (editor.focused !== true) return tap('打开键盘');
    return editor.text === '合成输入' ? tap('保存草稿') : input(editor, '合成输入');
  }
  if (scene === 'overlay') {
    if (has('已打开被遮挡目标')) return null;
    return tap(has('关闭浮层') ? '关闭浮层' : '打开被遮挡目标');
  }
  if (scene === 'long_list') {
    if (has('合成项目 42 的详细信息')) return null;
    if (has('合成项目 42')) return tap('合成项目 42');
    const scroller = by(node => node.scrollable === true, 'scrollable');
    return { action: 'scroll', arguments: { ...target(scroller), direction: 'forward' } };
  }
  if (scene === 'webview') {
    if (has('合成网页已保存')) return null;
    if (!nodes.some(node => node.editable === true)) return { tool: 'wait_for_ui_change', arguments: {
      sinceRevision: tree.revision, timeoutMs: 1500, selector: { editable: true },
    } };
    const editor = by(node => node.editable === true, 'editable');
    return editor.text === '合成网页' ? tap('保存网页内容') : input(editor, '合成网页');
  }
  if (scene === 'canvas') return null; // No visual tool in this production client; never guess coordinates.
  throw new Error('UNKNOWN_FIXTURE');
}

