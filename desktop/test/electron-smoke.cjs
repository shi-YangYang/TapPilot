// Run with: node test/run-electron-smoke.cjs electron-smoke.cjs
// Temporary profile, own-window UI, synthetic demo and local model endpoint only.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { until, createUi } = require('./electron-ui.cjs');
const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-electron-smoke-'));
const packageInfo = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
require('../dist/main.cjs');
let server;
(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const window = BrowserWindow.getAllWindows()[0];
  const ui = createUi(window);
  const { js } = ui;
  await ui.waitVisible('#demo-button');
  await until(async () => (await js('window.tapPilot.state()')).result.version === packageInfo.version);
  const screenshots = process.env.TAPPILOT_UI_SCREENSHOTS;
  const capture = name => ui.capture(screenshots && path.join(screenshots, `${name}.png`));
  if (process.env.TAPPILOT_UI_ONLY === '1') {
    // Render-only refresh after a visual change: no model, pairing, demo or task run.
    await capture('task');
    await ui.page('model'); await capture('model');
    await ui.page('device'); await ui.click('#mode-wireless'); await capture('device');
    window.setSize(960, 700);
    await capture('device-narrow');
    await ui.page('model'); await capture('model-narrow');
    await ui.page('task'); await capture('task-narrow');
    rmSync(directory, { recursive: true, force: true });
    process.stdout.write(`Rendered fresh-profile ${packageInfo.version} pages at default and minimum window size; functional tests were not repeated.\n`);
    app.exit(0); return;
  }
  assert.equal(await js('typeof require'), 'undefined');
  const state = await js('window.tapPilot.state()');
  assert.equal(state.ok, true); assert.equal('apiKey' in state.result.config, false);
  assert.equal((await js('window.tapPilot.run({task:"test",serial:""})')).ok, false);
  await ui.checkLayout('task'); await capture('task');

  // This is real Chromium text input, so a broken React controlled binding fails later.
  const prompt = '读取当前手机界面，简要总结可见内容。';
  await ui.type('#task-input', prompt);
  await ui.page('model', true);
  await ui.checkLayout('model');
  const syntheticKey = 'synthetic-desktop-smoke-key';
  let modelRequests = 0;
  server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${syntheticKey}` || request.url !== '/v1/chat/completions') { response.writeHead(403).end(); return; }
    modelRequests++;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { total_tokens: 4 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await ui.type('#base-url', baseUrl);
  await ui.type('#model-name', 'synthetic-model');
  await ui.type('#api-key', syntheticKey);
  await ui.click('#save-model');
  await until(async () => {
    const current = (await js('window.tapPilot.state()')).result.config;
    return current.hasKey && current.model === 'synthetic-model' && current.baseUrl === baseUrl;
  });
  await until(() => js('document.getElementById("api-key").value === ""'));
  assert.equal(readFileSync(path.join(directory, 'settings.json'), 'utf8').includes(syntheticKey), false);
  assert.equal('apiKey' in (await js('window.tapPilot.state()')).result.config, false);
  assert.match(await js('document.getElementById("key-status").textContent'), /保存/);
  await ui.click('#test-model');
  await until(() => js('document.getElementById("model-test-result")?.textContent.includes("连接成功")'));
  assert.equal(modelRequests, 1);
  assert.equal(await js('document.getElementById("api-key").value'), '');
  await ui.waitVisible('#page-model');
  await capture('model');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined;

  await ui.page('device', true);
  await ui.click('#mode-wireless');
  await until(async () => (await js('window.tapPilot.wirelessInterfaces()')).ok);
  await ui.checkLayout('device'); await capture('device');
  // The real beUI Select keeps its own ID. The application's stable wrapper is used.
  const selectTrigger = '#lan-address button[aria-haspopup="listbox"]';
  if (await ui.visible(selectTrigger) && !(await js(`document.querySelector(${JSON.stringify(selectTrigger)}).disabled`))) {
    await ui.focus(selectTrigger); await ui.key('Enter');
    await until(() => js('document.querySelector("#lan-address [role=listbox]")?.getAttribute("aria-hidden") === "false"'));
    await ui.key('Tab');
    assert.equal(await js('document.activeElement?.getAttribute("role")'), 'option');
    await ui.key('Enter');
    await until(() => js('document.querySelector("#lan-address [role=listbox]")?.getAttribute("aria-hidden") === "true"'));
    await ui.focus(selectTrigger); await ui.key('Enter'); await ui.key('Escape');
    await until(() => js('document.querySelector("#lan-address [role=listbox]")?.getAttribute("aria-hidden") === "true"'));
  }
  await ui.focus('#mode-usb'); await ui.key('Enter'); await ui.waitVisible('#usb-panel');
  await ui.focus('#mode-wireless'); await ui.key('Enter'); await ui.waitVisible('#wireless-panel');
  window.setSize(960, 700);
  await ui.checkLayout('device narrow'); await capture('device-narrow');
  await ui.page('model'); await ui.checkLayout('model narrow'); await capture('model-narrow');
  assert.equal(await js('document.getElementById("api-key").value'), '');
  await ui.page('task'); await ui.checkLayout('task narrow'); await capture('task-narrow');
  assert.equal(await js('document.getElementById("task-input").value'), prompt);
  // Submission must go through the new PromptInput callback and request device selection.
  await ui.click('#run-button'); await ui.waitVisible('#page-device');
  assert.match(await js('document.getElementById("notice").textContent'), /连接.*手机/);
  await ui.page('task');
  window.setSize(1190, 820);
  await ui.click('#demo-button');
  await until(() => js('document.getElementById("run-badge")?.textContent === "演示完成"'));
  assert.match(await js('document.getElementById("answer").textContent'), /合成界面/);
  assert.equal(await ui.visible('#demo-banner'), true);
  await ui.capture(process.env.TAPPILOT_SMOKE_SCREENSHOT);
  await ui.click('#demo-button');
  await until(() => js('document.getElementById("run-badge")?.textContent === "演示中"'));
  await ui.click('#cancel-button');
  await until(() => js('document.getElementById("run-badge")?.textContent === "已取消"'));
  await ui.waitVisible('#run-button');
  assert.equal(await js('document.getElementById("task-input").value'), prompt);
  rmSync(directory, { recursive: true, force: true });
  process.stdout.write(`Electron smoke passed (${packageInfo.version}): original React components, controlled text input and submit, keyboard Tabs/Select, three-page minimum-window layout, UI model save/test, encrypted synthetic key without refill, visible demo and UI cancellation.\n`);
  app.exit(0);
})().catch(error => {
  server?.closeAllConnections(); server?.close();
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
  process.stderr.write(`${error.message}\n`); app.exit(1);
});
