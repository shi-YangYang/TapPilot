// Isolated renderer regression; synthetic events only, no model or phone connection.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
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
  const { js, waitVisible } = createUi(window);
  await waitVisible('#demo-button');
  await until(() => js('!document.getElementById("demo-button").disabled'));
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
  process.stdout.write('PASS task diagnostics, failure reason alongside model answer, completion metrics and next-run reset\n');
})().catch(error => { process.exitCode = 1; process.stderr.write(`FAIL ${error.stack}\n`); }).finally(() => {
  clearTimeout(deadline);
  rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
