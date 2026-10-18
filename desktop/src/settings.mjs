import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ClientError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ClientError('INVALID_INPUT', '请求格式不正确。');
  }
  return value;
}

function string(value, maximum, label, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new ClientError('INVALID_INPUT', `${label}格式不正确。`);
  return value.trim();
}

export function validateConfig(value) {
  // Accept the retired field from older clients, but never retain or forward it.
  object(value, ['baseUrl', 'apiKey', 'model', 'vision', 'maxOutputTokens', 'clearKey', 'adbPath', 'serial', 'mode']);
  const baseUrl = string(value.baseUrl, 2048, 'API 地址');
  const model = string(value.model, 200, '模型名称');
  if (value.vision !== undefined && typeof value.vision !== 'boolean') throw new ClientError('INVALID_INPUT', '图片支持选项格式不正确。');
  const vision = value.vision === true;
  const apiKey = string(value.apiKey, 8192, 'API Key', true);
  const adbPath = string(value.adbPath, 4096, 'ADB 路径', true);
  const serial = string(value.serial, 200, '设备编号', true);
  const mode = value.mode ?? 'usb';
  if (!['usb', 'wireless'].includes(mode)) throw new ClientError('INVALID_MODE', '请选择 USB 或无线连接。');
  if (value.clearKey !== undefined && typeof value.clearKey !== 'boolean') throw new ClientError('INVALID_INPUT', '清除密钥参数不正确。');
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new ClientError('INVALID_ENDPOINT', '请填写完整的 API 地址，例如 https://api.example.com/v1。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && local)) {
    throw new ClientError('INVALID_ENDPOINT', 'API 地址必须使用 HTTPS；本机模型可使用 http://localhost。地址不能包含密码、查询参数或片段。');
  }
  if (!model) throw new ClientError('INVALID_MODEL', '请填写模型名称。');
  if (adbPath && !path.isAbsolute(adbPath)) throw new ClientError('INVALID_ADB_PATH', 'ADB 路径必须是绝对路径。');
  if (serial && !/^[a-zA-Z0-9._:-]+$/.test(serial)) throw new ClientError('INVALID_SERIAL', '设备编号格式不正确。');
  return { baseUrl, model, vision, apiKey, adbPath, serial, mode, clearKey: value.clearKey === true };
}

export const defaults = { baseUrl: '', model: '', vision: false, apiKey: '', adbPath: '', serial: '', mode: 'wireless' };

export class SettingsStore {
  constructor(directory, cipher) { this.directory = directory; this.file = path.join(directory, 'settings.json'); this.cipher = cipher; this.current = { ...defaults }; }
  async load() {
    let stored;
    try { stored = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return this.public(); throw new ClientError('SETTINGS_UNREADABLE', '无法读取本机配置，请在设置中重新保存。'); }
    try {
      object(stored, ['version', 'baseUrl', 'model', 'vision', 'maxOutputTokens', 'adbPath', 'serial', 'encryptedKey', 'mode']);
      if (stored.version !== 1) throw new Error('version');
      this.current = { ...validateConfig({ baseUrl: stored.baseUrl, model: stored.model, vision: stored.vision, adbPath: stored.adbPath, serial: stored.serial, mode: stored.mode }), apiKey: '' };
      if (stored.encryptedKey) this.current.apiKey = await this.cipher.decrypt(Buffer.from(stored.encryptedKey, 'base64'));
      return this.public();
    } catch { this.current = { ...defaults }; throw new ClientError('KEYCHAIN_UNAVAILABLE', '无法解密保存的配置。请重新输入模型配置和 API Key。'); }
  }
  public() { const { apiKey, clearKey, ...visible } = this.current; return { ...visible, hasKey: Boolean(apiKey) }; }
  async save(value) {
    const next = validateConfig(value);
    const sameOrigin = this.current.baseUrl && new URL(next.baseUrl).origin === new URL(this.current.baseUrl).origin;
    // A new provider must not receive the previous provider's retained secret.
    next.apiKey = next.clearKey ? '' : next.apiKey || (sameOrigin ? this.current.apiKey : '');
    // Keychain failure must never fall back to plaintext storage.
    const encryptedKey = next.apiKey ? (await this.cipher.encrypt(next.apiKey)).toString('base64') : '';
    const stored = { version: 1, baseUrl: next.baseUrl, model: next.model, vision: next.vision, adbPath: next.adbPath, serial: next.serial, mode: next.mode, encryptedKey };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
    await rename(temporary, this.file);
    this.current = next;
    return this.public();
  }
  model() { const { baseUrl, model, vision, apiKey } = this.current; validateConfig({ baseUrl, model, vision, apiKey }); return { baseUrl, model, vision, apiKey }; }
}

export function taskInput(value) {
  object(value, ['task', 'serial', 'mode', 'deviceId']);
  const task = string(value.task, 8000, '任务');
  if (!task) throw new ClientError('EMPTY_TASK', '请先输入任务。');
  const mode = value.mode ?? 'usb';
  if (mode === 'wireless') {
    const deviceId = string(value.deviceId, 128, '无线设备编号');
    if (!/^[a-zA-Z0-9._:-]+$/.test(deviceId) || value.serial !== undefined) throw new ClientError('NO_DEVICE', '请选择已配对的无线手机。');
    return { task, mode, deviceId };
  }
  if (mode !== 'usb' || value.deviceId !== undefined) throw new ClientError('INVALID_MODE', '连接方式与设备信息不匹配。');
  const serial = string(value.serial, 200, '设备编号');
  if (!serial || !/^[a-zA-Z0-9._:-]+$/.test(serial)) throw new ClientError('NO_DEVICE', '请先在设备页选择已授权的手机。');
  return { task, mode, serial };
}

export function assertSender(event, window, expectedUrl) {
  if (!window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== expectedUrl) {
    throw new ClientError('UNTRUSTED_SENDER', '请求来源不被允许。');
  }
}
