// Run with: electron test/electron-smoke.cjs. Uses a temporary profile and synthetic demo only.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
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
  // Exercise the redesigned pages using the temporary profile and synthetic display data.
  // This fixture never opens a pairing listener, calls a model, or touches a phone.
  const screenshots = process.env.TAPPILOT_UI_SCREENSHOTS;
  if (screenshots) mkdirSync(screenshots, { recursive: true });
  const capture = async name => {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await js('Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))');
    if (screenshots) writeFileSync(path.join(screenshots, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const checkLayout = async name => {
    const layout = await js(`(() => {
      const visible = [...document.querySelectorAll('button, input:not([type=checkbox]):not([type=radio]), select')].filter(item => item.getClientRects().length);
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        small: visible.filter(item => item.getBoundingClientRect().height < 32).map(item => item.id || item.textContent.trim()),
        clipped: visible.filter(item => { const rect = item.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth; }).map(item => item.id || item.textContent.trim()) };
    })()`);
    assert.equal(layout.overflow, false, `${name}: horizontal page overflow`);
    assert.deepEqual(layout.small, [], `${name}: controls under 32px`);
    assert.deepEqual(layout.clipped, [], `${name}: clipped controls`);
  };
  await checkLayout('task'); await capture('task');
  await js('document.querySelector("[data-page=model]").click()');
  await checkLayout('model'); await capture('model');
  await js('document.querySelector("[data-page=device]").click(); document.getElementById("mode-wireless").click()');
  const syntheticQr = await require('qrcode').toDataURL('TapPilot UI preview only — not a pairing credential');
  await js(`(() => {
    document.getElementById('lan-address').replaceChildren(new Option('192.168.50.2 · 示例网络', '192.168.50.2'));
    document.getElementById('lan-hint').textContent = '选择当前 Wi-Fi 的地址。';
    document.getElementById('pairing-panel').hidden = false;
    document.getElementById('pairing-qr').src = ${JSON.stringify(syntheticQr)};
    document.getElementById('pairing-expiry').textContent = '演示二维码 · 无法用于连接';
    document.getElementById('pairing-link').value = 'TapPilot UI preview only';
    document.getElementById('wireless-badge').textContent = '演示布局';
  })()`);
  await checkLayout('device'); await capture('device');
  window.setSize(960, 700);
  await capture('device-narrow'); await checkLayout('device narrow');
  await js('document.querySelector("[data-page=model]").click()');
  await capture('model-narrow'); await checkLayout('model narrow');
  await js('document.querySelector("[data-page=task]").click()');
  await capture('task-narrow'); await checkLayout('task narrow');
  if (process.env.TAPPILOT_UI_ONLY === '1') {
    process.stdout.write('UI screenshots saved after navigation transitions; runtime smoke was not repeated.\n');
    app.exit(0); return;
  }
  window.setSize(1190, 820);
  await js('clearPairing(); showWireless({ connected: false, closed: true, pairingAvailable: false })');
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
  process.stdout.write('Electron smoke passed: three-page layout and minimum-window controls, isolated renderer, no key exposure, input validation, visible synthetic demo, cancellation, model navigation, OS-encrypted synthetic key and mock model connection.\n');
  app.exit(0);
})().catch(error => { process.stderr.write(`${error.message}\n`); app.exit(1); });
app.on('will-quit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} });
