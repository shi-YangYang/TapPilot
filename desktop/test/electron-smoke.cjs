// Run with: electron test/electron-smoke.cjs. Uses a temporary profile and synthetic demo only.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-electron-smoke-'));
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
require('../dist/main.cjs');
async function until(predicate, deadline = 10000) {
  const start = Date.now();
  while (Date.now() - start < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('UI state deadline');
}
(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const window = BrowserWindow.getAllWindows()[0];
  const js = code => window.webContents.executeJavaScript(code, true);
  await until(async () => await js('Boolean(document.getElementById("demo-button") && window.tapPilot)'));
  assert.equal(await js('typeof require'), 'undefined');
  const state = await js('window.tapPilot.state()');
  assert.equal(state.ok, true); assert.equal('apiKey' in state.result.config, false);
  const invalid = await js('window.tapPilot.run({task:"test",serial:""})'); assert.equal(invalid.ok, false);
  await js('document.getElementById("demo-button").click()');
  await until(async () => (await js('document.getElementById("run-badge").textContent')) === '演示完成');
  assert.match(await js('document.getElementById("answer").textContent'), /合成界面/);
  assert.equal(await js('document.getElementById("demo-banner").hidden'), false);
  const screenshot = process.env.TAPPILOT_SMOKE_SCREENSHOT;
  if (screenshot) writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
  await until(async () => !(await js('document.getElementById("demo-button").disabled')));
  await js('document.getElementById("demo-button").click()');
  await until(async () => (await js('document.getElementById("run-badge").textContent')) === '演示中');
  await js('document.getElementById("cancel-button").click()');
  await until(async () => (await js('document.getElementById("run-badge").textContent')) === '已取消');
  await js('document.querySelector("[data-page=model]").click()');
  assert.equal(await js('document.getElementById("page-model").hidden'), false);
  const syntheticKey = 'synthetic-desktop-smoke-key';
  let modelRequests = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${syntheticKey}` || request.url !== '/v1/chat/completions') { response.writeHead(403).end(); return; }
    modelRequests++;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { total_tokens: 4 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const input = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: syntheticKey, model: 'synthetic-model', serial: '', adbPath: '' };
  try {
    const saved = await js(`window.tapPilot.saveConfig(${JSON.stringify(input)})`);
    assert.equal(saved.ok, true); assert.equal(saved.result.hasKey, true); assert.equal('apiKey' in saved.result, false);
    assert.equal(readFileSync(path.join(directory, 'settings.json'), 'utf8').includes(syntheticKey), false);
    const tested = await js('window.tapPilot.testModel()');
    assert.equal(tested.ok, true); assert.equal(tested.result.model, 'synthetic-model'); assert.equal(modelRequests, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
  process.stdout.write('Electron smoke passed: isolated renderer, no key exposure, input validation, visible synthetic demo, cancellation, model navigation, OS-encrypted synthetic key and mock model connection.\n');
  app.exit(0);
})().catch(error => { process.stderr.write(`${error.message}\n`); app.exit(1); });
app.on('will-quit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} });
