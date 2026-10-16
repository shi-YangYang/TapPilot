// Run with: node test/run-electron-smoke.cjs electron-wireless-smoke.cjs
// Real React UI + production wireless controller; only the phone and LLM are synthetic.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { createHash, X509Certificate } = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { until, createUi } = require('./electron-ui.cjs');
const requireServer = createRequire(path.resolve(__dirname, '../../server/package.json'));
const WebSocket = requireServer('ws');
const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-wireless-smoke-'));
const packageInfo = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
require('../dist/main.cjs');
const snapshot = revision => ({ snapshotId: `synthetic:${revision}`, revision, windowId: 4, packageName: 'com.android.settings', truncated: false, nodes: [{ nodeId: 'n0', parentId: null, text: revision === 1 ? '电池' : '电量 82%', contentDescription: '', resourceId: 'android:id/title', className: 'android.widget.TextView', bounds: [0, 50, 300, 100], clickable: true, scrollable: false, editable: false, enabled: true, password: false }] });
let server;
let phone;
(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const window = BrowserWindow.getAllWindows()[0];
  const ui = createUi(window);
  const { js } = ui;
  await ui.waitVisible('#demo-button');
  assert.equal((await js('window.tapPilot.state()')).result.version, packageInfo.version);
  // Read-only and rejection checks may call public IPC; all successful user actions use UI.
  assert.equal((await js('window.tapPilot.wirelessStart({host:"0.0.0.0"})')).ok, false);
  await ui.page('device');
  await ui.click('#mode-wireless');
  await ui.click('#start-pairing');
  await until(() => js('Boolean(document.getElementById("pairing-link")?.value)'));
  const uri = new URL(await js('document.getElementById("pairing-link").value'));
  const token = uri.searchParams.get('token');
  const fingerprint = uri.searchParams.get('fingerprint');
  assert.equal(JSON.stringify(await js('window.tapPilot.state()')).includes(token), false);
  assert.equal(await ui.visible('#pairing-panel'), true);
  assert.equal(await js('document.getElementById("pairing-qr").src.startsWith("data:image/png;base64,")'), true);
  // Pairing secrets stay in memory. TLS bypass is fixture-only and the leaf pin is
  // checked before sending the credential, just as the production phone authenticates it.
  const connectPhone = async () => {
    const socket = new WebSocket(`wss://${uri.searchParams.get('host')}:${uri.searchParams.get('port')}/phone`, { rejectUnauthorized: false, perMessageDeflate: false, handshakeTimeout: 5000 });
    socket.on('error', () => {});
    await once(socket, 'open');
    const leaf = new X509Certificate(socket._socket.getPeerCertificate().raw);
    assert.equal(createHash('sha256').update(leaf.raw).digest('hex') === fingerprint, true, 'Synthetic peer certificate pin');
    assert.ok(Date.parse(leaf.validTo) > Date.now() && Date.parse(leaf.validFrom) <= Date.now());
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', version: 1, token, deviceId: 'synthetic-wireless-phone', deviceName: '合成 Android · 无真实手机' }));
    assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
    return socket;
  };
  phone = await connectPhone();
  const methods = [];
  let fixtureError;
  const respond = data => {
    try {
      const request = JSON.parse(String(data)); methods.push(request.method);
      const result = request.method === 'act_and_observe' ? { action: { accepted: true, revision: 2 }, observation: snapshot(2), timings: { totalMs: 1 } } : request.method === 'emergency_stop' ? { stopped: true } : request.method === 'get_device_info' ? { serviceConnected: true, stopped: false } : snapshot(1);
      phone.send(JSON.stringify({ id: request.id, ok: true, result, meta: { durationMs: 1 } }));
    } catch { fixtureError = new Error('Synthetic phone fixture rejected an RPC'); }
  };
  phone.on('message', respond);
  await until(() => js('document.getElementById("wireless-badge")?.textContent === "已连接"'));
  const pairingCleared = () => js('!document.getElementById("pairing-panel") && !document.getElementById("pairing-qr") && !document.getElementById("pairing-link")');
  await until(pairingCleared);
  await ui.click('#select-wireless');
  await until(() => js('document.getElementById("connection-label").textContent.includes("无线")'));
  await ui.capture(process.env.TAPPILOT_WIRELESS_SCREENSHOT);

  const task = '读取电池页面，告诉我当前电量。';
  let modelRequests = 0; let hold = false; let held = 0;
  server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        assert.equal(body.includes(token), false); assert.equal(body.includes(fingerprint), false);
        assert.equal(body.includes(task), true, 'React task value reached the model');
        modelRequests++;
        if (hold) { held++; return; }
        const message = modelRequests === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-click', type: 'function', function: { name: 'act_and_observe', arguments: JSON.stringify({ action: 'click_element', arguments: { snapshotId: 'synthetic:1', nodeId: 'n0' }, waitMs: 0 }) } }] } : { role: 'assistant', content: '合成无线任务完成：当前电量 82%。' };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message, finish_reason: modelRequests === 1 ? 'tool_calls' : 'stop' }] }));
      } catch { fixtureError = new Error('Synthetic model fixture rejected context or detected a secret'); response.writeHead(500).end(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await ui.page('model');
  await ui.type('#base-url', `http://127.0.0.1:${server.address().port}/v1`);
  await ui.type('#model-name', 'synthetic-wireless-model');
  await ui.click('#save-model');
  await until(async () => (await js('window.tapPilot.state()')).result.config.model === 'synthetic-wireless-model');
  await ui.page('task');
  await ui.type('#task-input', task);
  const start = async () => {
    await ui.click('#run-button');
    await until(() => { if (fixtureError) throw fixtureError; return js('document.getElementById("run-badge")?.textContent === "运行中"'); });
  };
  // Native Enter exercises PromptInput's submit keyboard path, including its controlled value.
  await ui.focus('#task-input'); await ui.key('Enter');
  await until(async () => {
    if (fixtureError) throw fixtureError;
    return await js('document.getElementById("run-badge")?.textContent === "已完成"');
  });
  assert.match(await js('document.getElementById("answer").textContent'), /82%/);
  assert.deepEqual(methods, ['get_ui_tree', 'act_and_observe']);
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  assert.equal((await js('window.tapPilot.state()')).result.wireless.connected, true);
  hold = true;
  await start(); await until(() => held === 1);
  await ui.click('#cancel-button');
  await until(() => js('document.getElementById("run-badge")?.textContent === "已取消"'));
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  assert.equal((await js('window.tapPilot.state()')).result.wireless.connected, true);
  await start(); await until(() => held === 2);
  phone.terminate();
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  await until(async () => !(await js('window.tapPilot.state()')).result.wireless.connected);
  await until(pairingCleared);
  const beforeReconnect = methods.length;
  const requestsBeforeReconnect = modelRequests;
  phone = await connectPhone(); phone.on('message', respond);
  await until(async () => (await js('window.tapPilot.state()')).result.wireless.connected);
  assert.equal((await js('window.tapPilot.state()')).result.running, false);
  assert.equal(methods.length, beforeReconnect); assert.equal(modelRequests, requestsBeforeReconnect);
  await ui.page('device'); await ui.click('#select-wireless'); await until(pairingCleared);
  await ui.page('task');
  await start(); await until(() => held === 3);
  await ui.click('#emergency-button');
  await until(() => methods.includes('emergency_stop'));
  await until(() => js('document.getElementById("notice").textContent.includes("已急停")'));
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  assert.equal((await js('window.tapPilot.state()')).result.wireless.connected, true);
  await ui.page('device'); await ui.click('#stop-pairing');
  await until(async () => (await js('window.tapPilot.state()')).result.wireless.closed);
  await until(pairingCleared);
  assert.equal(readFileSync(path.join(directory, 'settings.json'), 'utf8').includes(token), false);
  assert.equal(fixtureError, undefined);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined;
  rmSync(directory, { recursive: true, force: true });
  process.stdout.write(`Wireless Electron smoke passed (${packageInfo.version}): UI pairing/model save/controlled submit/cancel/emergency stop, pinned synthetic WSS phone, QR clearing, action/observation loop, reconnect without replay, no credentials in model/config/screenshots.\n`);
  app.exit(0);
})().catch(error => {
  phone?.terminate(); server?.closeAllConnections(); server?.close();
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
  process.stderr.write(`${error.message}\n`); app.exit(1);
});
