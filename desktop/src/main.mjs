import { app, BrowserWindow, clipboard, ipcMain, Menu, safeStorage, session } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runAgent, testModel, RuntimeError } from '../../server/dist/runtime/index.js';
import { DiagnosticStore } from '../../server/dist/diagnostics/index.js';
import { createUsbClient, createWirelessClient, listUsbDevices } from '../../server/dist/client-tools.js';
import { WirelessHub, listLANAddresses } from '../../server/dist/wireless.js';
import QRCode from 'qrcode';
import { ClientError, SettingsStore, taskInput, object, assertSender } from './settings.mjs';
import { runDemo } from './demo.mjs';
import { WirelessSession } from './wireless-session.mjs';
import { createModelFetch } from './model-network.mjs';

app.setName('TapPilot');
let window;
let store;
let diagnostics;
let active;
let stopping = false;
let modelTest;
let modelFetch;
let startupError;
let wireless;
let savingConfig = false;
const page = path.join(app.getAppPath(), 'dist', 'index.html');
const pageUrl = pathToFileURL(page).href;
const publicEvent = value => {
  const result = {};
  for (const key of ['type', 'turn', 'toolName', 'action', 'ok', 'errorCode', 'errorReason', 'observationChanged', 'durationMs', 'metrics', 'answer']) if (value[key] !== undefined) result[key] = value[key];
  if (value.error) result.error = runtimeError(value.error);
  return result;
};
function send(value) { if (window && !window.isDestroyed()) window.webContents.send('tappilot:event', value); }
function safeMessage(error) {
  if (error instanceof ClientError) return error.message;
  if (error instanceof RuntimeError) return error.message;
  const messages = {
    INVALID_ENDPOINT: 'API 地址不受支持，请检查模型设置。',
    HTTP_ERROR: '模型服务拒绝了请求，请检查地址、密钥、模型名称和额度。',
    MODEL_HTTP_ERROR: '模型服务拒绝了请求，请检查地址、密钥、模型名称和额度。',
    TIMEOUT: '请求超时，请检查网络或手机连接。',
    CANCELLED: '操作已取消。',
    CONFIRMATION_REQUIRED: '该操作需要独立确认，已停止执行。请查看项目批准说明。',
    NO_DEVICE: '没有发现可用 USB 手机。请检查设备页的连接说明。',
    DEVICE_NOT_FOUND: '未找到选择的手机，请重新连接并刷新设备。',
    DEVICE_UNAVAILABLE: 'USB 手机离线或未授权。请解锁手机并允许 USB 调试，再重新开始任务；没有授权弹窗时，请重新插拔数据线。',
    EMERGENCY_STOPPED: '手机处于急停状态，请在手机 TapPilot 中手动恢复。',
    SERVICE_NOT_CONNECTED: '手机无障碍服务尚未连接，请在手机中开启 TapPilot。',
    WIRELESS_DISCONNECTED: '无线手机已断开。请重新连接后开始新任务，旧动作不会自动重放。',
    WIRELESS_TLS_SETUP_FAILED: '无法建立加密会话，请确认 macOS 系统 OpenSSL 可用。',
    WIRELESS_LISTEN_FAILED: '无法监听所选地址，请刷新网络并检查端口或防火墙设置。',
    WIRELESS_TIMEOUT: '无线请求超时，动作结果可能未知。请检查手机界面后再开始新任务。'
  };
  return messages[error?.code] || '操作未完成。请检查模型配置、手机连接及无障碍服务状态。';
}
function runtimeError(error) {
  // This function is used only with the shared runtime's controlled error strings.
  if (typeof error === 'string' && /^[A-Z0-9_]{2,80}: /.test(error)) {
    const split = error.indexOf(': ');
    return { code: error.slice(0, split), message: error.slice(split + 2, 1500) };
  }
  return { code: 'RUNTIME_ERROR', message: safeMessage(error) };
}
function handle(name, operation) {
  ipcMain.handle(`tappilot:${name}`, async (event, value) => {
    try {
      assertSender(event, window, pageUrl);
      if (!['save-config', 'run', 'emergency-stop', 'wireless-start'].includes(name) && value !== undefined) throw new ClientError('INVALID_INPUT', '此请求不接受参数。');
      return { ok: true, result: await operation(value) };
    }
    catch (error) { return { ok: false, error: { code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'CLIENT_ERROR', message: safeMessage(error) } }; }
  });
}
async function adbPath() {
  if (store.current.adbPath) return store.current.adbPath;
  const candidates = [process.env.ADB_PATH, process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools/adb'), path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'), '/opt/homebrew/bin/adb', '/usr/local/bin/adb'];
  for (const candidate of candidates.filter(Boolean)) { try { await access(candidate); return candidate; } catch {} }
  return 'adb';
}
async function begin(value, demo) {
  if (active || stopping) throw new ClientError('RUNNING', '已有任务正在执行或停止，请稍后再试。');
  const input = demo ? undefined : taskInput(value);
  const model = demo ? undefined : store.model();
  if (input?.mode === 'wireless') wireless.forDevice(input.deviceId);
  const controller = new AbortController();
  const run = { controller, client: undefined, demo, target: input };
  active = run;
  // Acknowledge immediately; long-running work reports progress through one-way events.
  void (async () => {
    try {
      send({ type: 'run_started', demo });
      const onEvent = event => send({ ...publicEvent(event), demo });
      let result;
      if (demo) result = await runDemo(controller.signal, onEvent);
      else {
        run.client = input.mode === 'wireless' ? createWirelessClient(wireless.forDevice(input.deviceId)) : await createUsbClient({ adbPath: await adbPath(), serial: input.serial });
        if (controller.signal.aborted) throw new ClientError('CANCELLED', '操作已取消。');
        result = await runAgent({ task: input.task, model, modelFetch, tools: run.client.tools, execute: (name, args, signal) => run.client.execute(name, args, signal), signal: controller.signal, onEvent, maxTurns: 24,
          diagnosticVersion: app.getVersion(), onDiagnostic: event => { void diagnostics.append(event); } });
      }
      send({ type: 'run_finished', demo, status: result.status, answer: result.answer || '', metrics: result.metrics, ...(result.error ? { error: runtimeError(result.error) } : {}) });
    } catch (error) {
      send({ type: 'run_finished', demo, status: controller.signal.aborted ? 'cancelled' : 'failed', answer: '', error: { code: error.code || 'CLIENT_ERROR', message: safeMessage(error) } });
    } finally {
      await run.client?.close().catch(() => {});
      if (active === run) active = undefined;
      send({ type: 'idle' });
    }
  })();
  return { started: true, demo };
}
async function emergency(value) {
  object(value, ['serial', 'mode', 'deviceId']);
  if (stopping) throw new ClientError('STOPPING', '正在请求急停。');
  const was = active;
  // Cancellation is local and immediate, even if phone stop cannot be confirmed.
  was?.controller.abort();
  if (was?.demo) return { phoneStopped: false, demo: true };
  // During a task, stop its pinned target even if the device page selection has changed.
  const target = was?.target ?? taskInput({ task: 'emergency-stop', ...value });
  stopping = true;
  let client;
  try {
    // Keep the stop request independent of the task session being closed after cancellation.
    client = target.mode === 'wireless' ? createWirelessClient(wireless.forDevice(target.deviceId)) : await createUsbClient({ adbPath: await adbPath(), serial: target.serial });
    const result = await client.execute('emergency_stop', {}, new AbortController().signal);
    if (result.ok === false) throw new ClientError('PHONE_STOP_UNCONFIRMED', '任务已取消，但未确认手机急停。请在手机点击急停或关闭无障碍服务。');
    send({ type: 'emergency_stopped' });
    return { phoneStopped: true };
  } catch { throw new ClientError('PHONE_STOP_UNCONFIRMED', '任务已取消，但未确认手机急停。请在手机点击急停或关闭无障碍服务。'); }
  finally { await client?.close().catch(() => {}); stopping = false; }
}

app.whenReady().then(async () => {
  // Separate privacy-whitelisted metadata sink. UI events contain answers and
  // must never be sent to persistent diagnostics.
  diagnostics = new DiagnosticStore({ rootDirectory: app.getPath('userData') });
  modelFetch = createModelFetch();
  wireless = new WirelessSession({ startHub: options => WirelessHub.start(options), addresses: listLANAddresses,
    qr: value => QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 3, width: 300, color: { dark: '#171717', light: '#ffffff' } }),
    onState: state => {
      if (active?.target?.mode === 'wireless' && (!state.connected || state.deviceId !== active.target.deviceId)) active.controller.abort();
      send({ type: 'wireless_state', state });
    } });
  store = new SettingsStore(app.getPath('userData'), {
    encrypt: async value => {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new ClientError('KEYCHAIN_UNAVAILABLE', '系统密钥存储不可用，无法安全保存 API Key。');
      return safeStorage.encryptStringAsync(value);
    },
    decrypt: async value => (await safeStorage.decryptStringAsync(value)).result
  });
  try { await store.load(); } catch (error) { startupError = safeMessage(error); }
  handle('state', () => ({ config: store.public(), running: Boolean(active), version: app.getVersion(), startupError, wireless: wireless.status() }));
  handle('save-config', async value => {
    if (active || savingConfig) throw new ClientError('RUNNING', '请等待任务或配置保存结束。');
    savingConfig = true;
    try { return await store.save(value); } finally { savingConfig = false; }
  });
  handle('test-model', async () => {
    if (active || modelTest) throw new ClientError('TEST_RUNNING', '请等待当前任务或模型测试结束。');
    const controller = new AbortController(); modelTest = controller;
    try { return await testModel(store.model(), controller.signal, modelFetch); } finally { modelTest = undefined; }
  });
  handle('devices', async () => (await listUsbDevices(await adbPath())).map(({ serial, state, usb, emulator, model }) => ({ serial, state, usb, emulator, model })));
  handle('wireless-interfaces', () => wireless.interfaces());
  handle('wireless-start', value => {
    if (active || stopping) throw new ClientError('RUNNING', '请结束当前任务后配对手机。');
    return wireless.start(value);
  });
  handle('wireless-close', async () => { if (active?.target?.mode === 'wireless') active.controller.abort(); await wireless.close(); return { closed: true }; });
  handle('wireless-copy', () => { clipboard.writeText(wireless.pairingUri()); return { copied: true }; });
  handle('run', value => begin(value, false));
  handle('demo', () => begin(undefined, true));
  handle('cancel', () => { active?.controller.abort(); modelTest?.abort(); return { cancelled: true }; });
  handle('emergency-stop', emergency);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  window = new BrowserWindow({ width: 1190, height: 820, minWidth: 960, minHeight: 700, title: 'TapPilot', backgroundColor: '#101010', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 }, webPreferences: { preload: path.join(app.getAppPath(), 'dist', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'TapPilot', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
  await window.loadFile(page);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { active?.controller.abort(); modelTest?.abort(); void active?.client?.close(); void wireless?.close(); });
