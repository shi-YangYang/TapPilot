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
  assert.match(timeline, /点击目标/);
  assert.match(timeline, /未完成/);
  assert.match(timeline, /目标不可点击/);
  assert.match(timeline, /NOT_CLICKABLE/);
  assert.match(timeline, /读取当前界面/);
  assert.match(timeline, /界面未变化/);
  assert.doesNotMatch(timeline, /操作并查看结果/);
  send({ type: 'run_finished', status: 'failed', error: { code: 'REPEATED_ACTION', message: '点击目标后界面未变化，已停止。' }, metrics: { totalMs: 130, modelMs: 0, toolMs: 130, modelRequests: 0, toolCalls: 2 } });
  await until(() => js('document.getElementById("answer")?.textContent.includes("点击目标后界面未变化")'));
  assert.equal(await js('document.getElementById("run-badge").textContent'), '未完成');
  // Finishing the run retains the diagnostic labels even when the timeline collapses.
  assert.match(await js('document.getElementById("timeline").textContent'), /NOT_CLICKABLE/);
  process.stdout.write('PASS task steps show concrete actions, failure codes and unchanged observations\n');
})().catch(error => { process.exitCode = 1; process.stderr.write(`FAIL ${error.stack}\n`); }).finally(() => {
  clearTimeout(deadline);
  rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
