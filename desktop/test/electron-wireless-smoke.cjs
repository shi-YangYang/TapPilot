// Own-app integration test: temporary profile, synthetic WSS phone and synthetic model only.
// It renders Electron content without sending input to or unlocking the macOS desktop.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { createHash, X509Certificate } = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const requireServer = createRequire(path.resolve(__dirname, '../../server/package.json'));
const WebSocket = requireServer('ws');
const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-wireless-smoke-'));
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
require('../dist/main.cjs');
async function until(predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Wireless UI state deadline');
}
const snapshot = revision => ({ snapshotId: `synthetic:${revision}`, revision, windowId: 4, packageName: 'com.android.settings', truncated: false, nodes: [{ nodeId: 'n0', parentId: null, text: revision === 1 ? '电池' : '电量 82%', contentDescription: '', resourceId: 'android:id/title', className: 'android.widget.TextView', bounds: [0, 50, 300, 100], clickable: true, scrollable: false, editable: false, enabled: true, password: false }] });
let server;
let phone;
(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const window = BrowserWindow.getAllWindows()[0];
  const js = source => window.webContents.executeJavaScript(source, true);
  await until(async () => await js('Boolean(window.tapPilot && document.getElementById("start-pairing"))'));
  const invalid = await js('window.tapPilot.wirelessStart({host:"0.0.0.0"})'); assert.equal(invalid.ok, false);
  await js('document.querySelector("[data-page=device]").click()');
  await until(async () => Boolean(await js('document.getElementById("lan-address").value')));
  await js('document.getElementById("start-pairing").click()');
  await until(async () => Boolean(await js('document.getElementById("pairing-link").value')));
  const uri = new URL(await js('document.getElementById("pairing-link").value'));
  const token = uri.searchParams.get('token');
  const fingerprint = uri.searchParams.get('fingerprint');
  const stateBefore = await js('window.tapPilot.state()');
  assert.equal(JSON.stringify(stateBefore).includes(token), false);
  assert.equal(await js('document.getElementById("pairing-panel").hidden'), false);
  assert.match(await js('document.getElementById("pairing-qr").src'), /^data:image\/png;base64,/);
  phone = new WebSocket(`wss://${uri.searchParams.get('host')}:${uri.searchParams.get('port')}/phone`, { rejectUnauthorized: false, perMessageDeflate: false });
  phone.on('error', () => {});
  await once(phone, 'open');
  const leaf = new X509Certificate(phone._socket.getPeerCertificate().raw);
  assert.equal(createHash('sha256').update(leaf.raw).digest('hex'), fingerprint);
  assert.ok(Date.parse(leaf.validTo) > Date.now() && Date.parse(leaf.validFrom) <= Date.now());
  const ready = once(phone, 'message');
  phone.send(JSON.stringify({ type: 'hello', version: 1, token, deviceId: 'synthetic-wireless-phone', deviceName: '合成 Android · 无真实手机' }));
  assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
  const methods = [];
  const respond = data => {
    const request = JSON.parse(String(data)); methods.push(request.method);
    const result = request.method === 'act_and_observe' ? { action: { accepted: true, revision: 2 }, observation: snapshot(2), timings: { totalMs: 1 } } : request.method === 'emergency_stop' ? { stopped: true } : request.method === 'get_device_info' ? { serviceConnected: true, stopped: false } : snapshot(1);
    phone.send(JSON.stringify({ id: request.id, ok: true, result, meta: { durationMs: 1 } }));
  };
  phone.on('message', respond);
  await until(async () => (await js('document.getElementById("wireless-badge").textContent')) === '已连接');
  assert.equal(await js('document.getElementById("pairing-link").value'), '');
  assert.equal(await js('document.getElementById("pairing-panel").hidden'), true);
  await js('document.getElementById("select-wireless").click()');
  assert.match(await js('document.getElementById("connection-label").textContent'), /无线/);
  if (process.env.TAPPILOT_WIRELESS_SCREENSHOT) writeFileSync(process.env.TAPPILOT_WIRELESS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  let modelRequests = 0; let hold = false; let held = 0;
  server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      assert.equal(body.includes(token), false); assert.equal(body.includes(fingerprint), false);
      modelRequests++;
      if (hold) { held++; return; }
      const message = modelRequests === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-click', type: 'function', function: { name: 'act_and_observe', arguments: JSON.stringify({ action: 'click_element', arguments: { snapshotId: 'synthetic:1', nodeId: 'n0' }, waitMs: 0 }) } }] } : { role: 'assistant', content: '合成无线任务完成：当前电量 82%。' };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message, finish_reason: modelRequests === 1 ? 'tool_calls' : 'stop' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'synthetic-model', apiKey: '', adbPath: '/nonexistent-adb-must-not-run', serial: '', mode: 'wireless' };
  assert.equal((await js(`window.tapPilot.saveConfig(${JSON.stringify(config)})`)).ok, true);
  const target = { mode: 'wireless', deviceId: 'synthetic-wireless-phone', task: '读取电池页面' };
  assert.equal((await js(`window.tapPilot.run(${JSON.stringify(target)})`)).ok, true);
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  assert.equal(await js('document.getElementById("run-badge").textContent'), '已完成', `synthetic failure: ${await js('document.getElementById("answer").textContent')} | requests=${modelRequests} | tools=${methods.join(',')}`);
  assert.match(await js('document.getElementById("answer").textContent'), /82%/);
  assert.deepEqual(methods, ['get_ui_tree', 'act_and_observe']);
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  assert.equal((await js('window.tapPilot.state()')).result.wireless.connected, true);
  hold = true;
  await js(`window.tapPilot.run(${JSON.stringify(target)})`);
  await until(() => held === 1);
  await js('window.tapPilot.cancel()');
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  assert.equal((await js('window.tapPilot.state()')).result.wireless.connected, true);
  await js(`window.tapPilot.run(${JSON.stringify(target)})`);
  await until(() => held === 2);
  phone.terminate();
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  await until(async () => !(await js('window.tapPilot.state()')).result.wireless.connected);
  const beforeReconnect = methods.length;
  phone = new WebSocket(`wss://${uri.searchParams.get('host')}:${uri.searchParams.get('port')}/phone`, { rejectUnauthorized: false });
  phone.on('error', () => {}); await once(phone, 'open');
  assert.equal(createHash('sha256').update(phone._socket.getPeerCertificate().raw).digest('hex'), fingerprint);
  const readyAgain = once(phone, 'message');
  phone.send(JSON.stringify({ type: 'hello', version: 1, token, deviceId: 'synthetic-wireless-phone', deviceName: '合成 Android · 无真实手机' }));
  assert.equal(JSON.parse(String((await readyAgain)[0])).type, 'ready');
  phone.on('message', respond);
  await until(async () => (await js('window.tapPilot.state()')).result.wireless.connected);
  assert.equal((await js('window.tapPilot.state()')).result.running, false);
  assert.equal(methods.length, beforeReconnect);
  await js(`window.tapPilot.run(${JSON.stringify(target)})`);
  await until(() => held === 3);
  const stopped = await js('window.tapPilot.emergencyStop({mode:"wireless",deviceId:"synthetic-wireless-phone"})');
  assert.equal(stopped.ok, true); assert.equal(stopped.result.phoneStopped, true); assert.ok(methods.includes('emergency_stop'));
  await until(async () => !(await js('window.tapPilot.state()')).result.running);
  assert.equal((await js('window.tapPilot.state()')).result.wireless.connected, true);
  await js('window.tapPilot.wirelessClose()');
  assert.equal((await js('window.tapPilot.state()')).result.wireless.closed, true);
  assert.equal(readFileSync(path.join(directory, 'settings.json'), 'utf8').includes(token), false);
  assert.equal(await js('document.getElementById("pairing-link").value'), '');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined;
  rmSync(directory, { recursive: true, force: true });
  process.stdout.write('Wireless Electron smoke passed: explicit LAN pairing, pinned synthetic WSS phone, QR clearing, model/action/observation loop without ADB, session reuse, cancellation, disconnect without replay, independent emergency stop, no pairing secrets in model or config.\n');
  app.exit(0);
})().catch(error => {
  phone?.terminate(); server?.closeAllConnections(); server?.close();
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
  process.stderr.write(`${error.stack}\n`); app.exit(1);
});
