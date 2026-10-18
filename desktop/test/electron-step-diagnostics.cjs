// Isolated renderer regression; synthetic events only, no model or phone connection.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { until, createUi } = require('./electron-ui.cjs');

const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-step-diagnostics-'));
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
require('../dist/main.cjs');
const deadline = setTimeout(() => { process.stderr.write('FAIL diagnostics deadline\n'); app.exit(1); }, 20000);

(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const window = BrowserWindow.getAllWindows()[0];
  const ui = createUi(window);
  const { js, waitVisible } = ui;
  await waitVisible('#demo-button');
  await until(() => js('!document.getElementById("demo-button").disabled'));
  await ui.page('model');
  assert.equal(await js('document.getElementById("model-vision").checked'), false);
  assert.match(await js('document.getElementById("model-vision-hint").textContent'), /发送截图给模型/);
  await ui.type('#base-url', 'https://synthetic.invalid/v1');
  await ui.type('#model-name', 'synthetic-model');
  await ui.click('#model-vision');
  await ui.click('#save-model');
  await until(async () => (await js('window.tapPilot.state()')).result.config.vision === true);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'settings.json'), 'utf8')).vision, true);
  await ui.page('task');
  await ui.page('model');
  assert.equal(await js('document.getElementById("model-vision").checked'), true);
  await ui.click('#model-vision');
  await ui.click('#save-model');
  await until(async () => (await js('window.tapPilot.state()')).result.config.vision === false);
  await ui.page('task');
  const send = event => window.webContents.send('tappilot:event', event);
  send({ type: 'run_started' });
  send({ type: 'tool_start', toolName: 'act_and_observe', action: 'click_element', turn: 1 });
  send({ type: 'tool_end', toolName: 'act_and_observe', action: 'click_element', ok: false, errorCode: 'NOT_CLICKABLE', durationMs: 80, turn: 1 });
  send({ type: 'tool_start', toolName: 'get_ui_tree', turn: 2 });
  send({ type: 'tool_end', toolName: 'get_ui_tree', ok: true, observationChanged: false, durationMs: 50, turn: 2 });
  await until(() => js('document.getElementById("timeline")?.textContent.includes("NOT_CLICKABLE")'));
  const timeline = await js('document.getElementById("timeline").textContent');
  assert.match(timeline, /原生点击/);
  assert.match(timeline, /未完成/);
  assert.match(timeline, /目标不可点击/);
  assert.match(timeline, /NOT_CLICKABLE/);
  assert.match(timeline, /读取当前界面/);
  assert.match(timeline, /界面未变化/);
  assert.doesNotMatch(timeline, /操作并查看结果/);
  send({ type: 'run_finished', status: 'failed', error: { code: 'REPEATED_ACTION', message: '点击目标后界面未变化，已停止。' }, metrics: { totalMs: 130, modelMs: 0, toolMs: 130, modelRequests: 0, toolCalls: 2 } });
  await until(() => js('document.getElementById("answer-error")?.textContent.includes("点击目标后界面未变化")'));
  assert.equal(await js('document.getElementById("run-badge").textContent'), '未完成');
  // Finishing the run retains the diagnostic labels even when the timeline collapses.
  assert.match(await js('document.getElementById("timeline").textContent'), /NOT_CLICKABLE/);
  send({ type: 'run_finished', status: 'failed', answer: 'Synthetic model claims completion.', error: { code: 'COMPLETION_CONTEXT_CHANGED', message: '收尾时页面已改变，无法确认完成。' }, metrics: { totalMs: 200, modelMs: 50, toolMs: 150, modelRequests: 1, toolCalls: 3, hostReads: 2, completionReads: 1 } });
  await until(() => js('document.getElementById("answer-error")?.textContent.includes("收尾时页面已改变")'));
  assert.equal(await js('document.getElementById("answer").textContent'), 'Synthetic model claims completion.');
  assert.match(await js('document.getElementById("answer-panel").textContent'), /模型说明 · 未确认完成/);
  assert.equal(await js('document.getElementById("answer-error").getAttribute("role")'), 'alert');
  assert.equal(await js('document.getElementById("run-badge").textContent'), '未完成');
  assert.equal(await js('document.getElementById("metric-host-reads").textContent'), '1 次');
  assert.equal(await js('document.getElementById("metric-completion-reads").textContent'), '1 次');
  send({ type: 'run_started' });
  await until(() => js('document.getElementById("run-badge").textContent === "运行中"'));
  assert.equal(await js('document.getElementById("answer-error")'), null, 'a new run clears the old failure');
  assert.equal(await js('document.getElementById("answer").textContent'), '');
  send({ type: 'run_finished', status: 'completed', answer: 'Synthetic verified result.' });
  await until(() => js('document.getElementById("run-badge").textContent === "已完成"'));
  assert.equal(await js('document.getElementById("answer").textContent'), 'Synthetic verified result.');
  assert.equal(await js('document.getElementById("answer-error")'), null);
  send({ type: 'run_started' });
  const screenshotErrors = {
    VISION_REQUIRED: '此页面需要支持图片的模型', MODEL_VISION_UNSUPPORTED: '模型不支持图片',
    SCREENSHOT_UNSUPPORTED: '此手机暂不支持截图观察', SCREENSHOT_PROTECTED: '截图受限，手机端未说明具体原因',
    SCREENSHOT_RATE_LIMITED: '截图过于频繁', SCREENSHOT_TIMEOUT: '截图超时',
    SCREENSHOT_FAILED: '无法获取截图', SCREENSHOT_CONTEXT_CHANGED: '截图期间页面已切换',
    VISUAL_OBSERVATION_ONLY: '此截图只支持观察', MODEL_IMAGE_LIMIT: '截图数据超出模型请求限制',
    SCREENSHOT_LIMIT: '本次任务截图观察已达上限', SCREENSHOT_UNAVAILABLE: '无法获得截图',
  };
  for (const [errorCode, label] of Object.entries(screenshotErrors)) {
    send({ type: 'tool_start', toolName: 'take_screenshot' });
    send({ type: 'tool_end', toolName: 'take_screenshot', ok: false, errorCode, durationMs: 50 });
    await until(() => js(`document.getElementById('timeline')?.textContent.includes(${JSON.stringify(errorCode)})`));
    const text = await js('document.getElementById("timeline").textContent');
    assert.match(text, /截图观察/);
    assert.ok(text.includes(label));
  }
  const screenshotReasons = { WINDOW_OBSCURED: '关闭悬浮窗', SYSTEM_SECURE_WINDOW: 'Android 将当前窗口标记为禁止截图',
    SCREENSHOT_ACCESS_DENIED: 'Android 拒绝了截图访问', SENSITIVE_NODE: '密码或敏感控件',
    SENSITIVE_SCAN_LIMIT: '无法完整确认', UNSUPPORTED_WINDOW: '当前窗口类型不支持' };
  for (const [errorReason, label] of Object.entries(screenshotReasons)) {
    send({ type: 'tool_start', toolName: 'take_screenshot' });
    send({ type: 'tool_end', toolName: 'take_screenshot', ok: false, errorCode: 'SCREENSHOT_PROTECTED', errorReason, durationMs: 50 });
    await until(() => js(`document.getElementById('timeline')?.textContent.includes(${JSON.stringify(label)})`));
  }
  const visualErrors = {
    VISUAL_REFERENCE_INVALID: '截图已失效', VISUAL_REFERENCE_EXPIRED: '截图已过期',
    VISUAL_CONTEXT_CHANGED: '页面已切换，未执行点按', VISUAL_SCENE_CHANGED: '画面已变化，未执行点按',
    VISUAL_TARGET_UNSAFE: '此目标需手动操作', VISUAL_ACTION_UNSUPPORTED: '此手机暂不支持看图点按',
    VISUAL_ACTION_UNAVAILABLE: '当前没有可用于点按的截图', VISUAL_NO_PROGRESS: '点按后未确认进展',
    VISUAL_OBSERVATION_FAILED: '点按后无法读取界面，请查看手机，不要重复点按',
  };
  for (const [errorCode, label] of Object.entries(visualErrors)) {
    send({ type: 'tool_start', toolName: 'tap_visual' });
    send({ type: 'tool_end', toolName: 'tap_visual', ok: false, errorCode, durationMs: 50 });
    await until(() => js(`document.getElementById('timeline')?.textContent.includes(${JSON.stringify(errorCode)})`));
    const text = await js('document.getElementById("timeline").textContent');
    assert.match(text, /看图点按/);
    assert.ok(text.includes(label));
  }
  process.stdout.write('PASS model image setting, screenshot and visual tap diagnostics, failure reason, completion metrics and next-run reset\n');
})().catch(error => { process.exitCode = 1; process.stderr.write(`FAIL ${error.stack}\n`); }).finally(() => {
  clearTimeout(deadline);
  rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
