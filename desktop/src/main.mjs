import { app, BrowserWindow, clipboard, ipcMain, Menu, safeStorage, session } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runAgent, testModel, RuntimeError } from '../../server/dist/runtime/index.js';
import { DiagnosticStore } from '../../server/dist/diagnostics/index.js';
import { LearningStore, summarizeCandidates, modelScope } from '../../server/dist/learning/index.js';
import { SkillStore } from '../../server/dist/skills/store.js';
import { ContinuousImprover } from '../../server/dist/skills/loop.js';
import { SKILL_POLICY_REVISION, SkillSpecSchema, skillHash } from '../../server/dist/skills/schema.js';
import { SkillUsageTracker } from '../../server/dist/skills/usage-outcome.js';
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
let learning;
let skills;
let improver;
let improvementStopped = false;
const revokedSkills = new Set();
const disabledExperiences = new Set();
let active;
let stopping = false;
let modelTest;
let modelFetch;
let startupError;
let wireless;
let savingConfig = false;
let managingSkills = false;
const page = path.join(app.getAppPath(), 'dist', 'index.html');
const pageUrl = pathToFileURL(page).href;
const publicEvent = value => {
  const result = {};
  for (const key of ['type', 'turn', 'toolName', 'action', 'ok', 'errorCode', 'errorReason', 'observationChanged', 'navigationSteps', 'navigationStopReason', 'durationMs', 'metrics', 'answer']) if (value[key] !== undefined) result[key] = value[key];
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
    UI_OBSERVATION_UNAVAILABLE: '等待后仍无法读取可用的手机界面，任务已停止。请查看手机当前页面。',
    VISION_REQUIRED: '此页面无法通过控件读取。请使用支持图片的模型，并在模型设置中开启“支持图片”。',
    MODEL_VISION_UNSUPPORTED: '当前模型拒绝了图片请求。请检查模型是否支持图片，或在模型设置中关闭“支持图片”。',
    SCREENSHOT_UNSUPPORTED: '此手机暂不支持截图观察，请手动查看当前页面。',
    SCREENSHOT_PROTECTED: '手机端限制了当前页面截图，但未提供具体原因。请查看手机当前页面。',
    SCREENSHOT_RATE_LIMITED: '截图过于频繁，请稍后重新开始任务。',
    SCREENSHOT_TIMEOUT: '截图超时，请检查手机状态后重新开始任务。',
    SCREENSHOT_FAILED: '无法获取手机截图，请检查手机状态。',
    SCREENSHOT_CONTEXT_CHANGED: '截图期间页面已切换，未使用这张截图。请重新开始任务。',
    VISUAL_OBSERVATION_ONLY: '此截图只支持观察，当前步骤需在手机上手动完成。',
    VISUAL_REFERENCE_INVALID: '截图已失效，未执行点按。请重新观察当前页面。',
    VISUAL_REFERENCE_EXPIRED: '截图已过期，未执行点按。请重新观察当前页面。',
    VISUAL_CONTEXT_CHANGED: '手机页面已切换，未执行点按。请重新观察当前页面。',
    VISUAL_SCENE_CHANGED: '截图中的画面已变化，未执行点按。请重新观察当前页面。',
    VISUAL_TARGET_UNSAFE: '无法安全确认这个目标，请在手机上手动操作。',
    VISUAL_ACTION_UNSUPPORTED: '此手机暂不支持看图点按，请手动完成当前步骤。',
    VISUAL_ACTION_UNAVAILABLE: '当前没有可用于点按的截图，请查看手机页面或更新配套手机端。',
    VISUAL_NO_PROGRESS: '点按后未确认任务进展，已停止。请查看手机上的实际结果。',
    VISUAL_OBSERVATION_FAILED: '点按后无法读取手机界面，任务已停止。操作可能已发生，请查看手机，不要重复点按。',
    MODEL_IMAGE_LIMIT: '截图数据超出模型请求限制，图片未发送。请查看手机当前页面。',
    SCREENSHOT_LIMIT: '本次任务截图观察已达上限，请在手机完成当前步骤后重新开始。',
    SCREENSHOT_UNAVAILABLE: '无法获得当前页面的截图，请检查手机端是否已更新并正常连接。',
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
      if (!['save-config', 'run', 'emergency-stop', 'wireless-start', 'improvement-set', 'skills-create', 'skills-update', 'skills-delete'].includes(name) && value !== undefined) throw new ClientError('INVALID_INPUT', '此请求不接受参数。');
      return { ok: true, result: await operation(value) };
    }
    catch (error) { return { ok: false, error: { code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'CLIENT_ERROR', message: safeMessage(error) } }; }
  });
}
function currentSkillScope() {
  try { return { hostVersion: app.getVersion(), policyRevision: SKILL_POLICY_REVISION, modelProfile: modelScope(store.model()).modelProfile }; }
  catch { return undefined; }
}
function skillInput(value, editing = false) {
  object(value, editing ? ['id', 'title', 'spec'] : ['title', 'spec']);
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80 || /[\u0000-\u001f\u007f]/.test(value.title))
    throw new ClientError('INVALID_INPUT', '技能名称需为 1–80 个字符。');
  const parsed = SkillSpecSchema.safeParse(value.spec);
  if (!parsed.success) throw new ClientError('INVALID_INPUT', '技能内容格式不正确，请检查条件和步骤。');
  return { title: value.title.trim(), spec: parsed.data };
}
function skillId(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.test(value))
    throw new ClientError('INVALID_INPUT', '技能编号不正确，请刷新列表。');
  return value;
}
const skillErrors = {
  SKILLS_INVALID_STORE: '技能库无法读取，请保留数据并检查存储。',
  SKILLS_STORAGE_UNAVAILABLE: '技能库暂时无法访问，请稍后重试。',
  SKILLS_LOCK_BUSY: '技能库正在使用，请稍后重试。',
  SKILLS_STORE_LIMIT: '技能库已满，请删除不再需要的技能。',
  SKILLS_NOT_FOUND: '技能已不存在，请刷新列表。',
  SKILLS_UNKNOWN_SKILL: '技能已不存在，请刷新列表。',
  SKILLS_INVALID_CANDIDATE: '技能内容无效或已过期，请检查后重试。',
  SKILLS_DUPLICATE_CANDIDATE: '已有相同内容的技能。',
  SKILLS_SCOPE_MISMATCH: '技能适用的模型或版本不匹配。',
  SKILLS_INVALID_INPUT: '技能内容格式不正确。',
  SKILLS_INVALID_MANAGED_SKILL: '技能内容、适用范围或有效期不正确，请检查后重试。',
  SKILLS_UNKNOWN_PARENT: '关联的原技能已不存在，请检查技能内容。',
};
async function skillRequest(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ClientError) throw error;
    const code = typeof error?.message === 'string' && Object.hasOwn(skillErrors, error.message) ? error.message : 'SKILLS_MANAGEMENT_FAILED';
    throw new ClientError(code, skillErrors[code] || '技能操作未完成，请刷新后重试。');
  }
}
async function mutateSkills(operation) {
  if (active || stopping || savingConfig || modelTest || managingSkills) throw new ClientError('RUNNING', '请等待当前操作结束后管理技能。');
  managingSkills = true;
  try {
    await improver.pause();
    const result = await skillRequest(operation);
    send({ type: 'skills_changed' });
    return result;
  } finally {
    managingSkills = false;
    if (!improvementStopped && !active && !stopping && !savingConfig && !modelTest) improver.schedule();
  }
}
async function adbPath() {
  if (store.current.adbPath) return store.current.adbPath;
  const candidates = [process.env.ADB_PATH, process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools/adb'), path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'), '/opt/homebrew/bin/adb', '/usr/local/bin/adb'];
  for (const candidate of candidates.filter(Boolean)) { try { await access(candidate); return candidate; } catch {} }
  return 'adb';
}
async function begin(value, demo) {
  if (active || stopping || savingConfig || modelTest || managingSkills) throw new ClientError('RUNNING', '已有任务正在执行或停止，请稍后再试。');
  const input = demo ? undefined : taskInput(value);
  const model = demo ? undefined : store.model();
  if (input?.mode === 'wireless') wireless.forDevice(input.deviceId);
  const controller = new AbortController();
  const run = { controller, client: undefined, demo, target: input };
  active = run;
  improvementStopped = false;
  // Acknowledge immediately; long-running work reports progress through one-way events.
  void (async () => {
    try {
      send({ type: 'run_started', demo });
      await improver.pause().catch(() => {});
      controller.signal.throwIfAborted();
      const onEvent = event => send({ ...publicEvent(event), demo });
      let result;
      if (demo) result = await runDemo(controller.signal, onEvent);
      else {
        const scope = modelScope(model);
        const learningSnapshot = (await learning.loadActive(app.getVersion(), scope.modelFamily, Date.now(), scope.modelProfile).catch(() => [])).filter(entry => !disabledExperiences.has(entry.id));
        const skillScope = { hostVersion: app.getVersion(), policyRevision: SKILL_POLICY_REVISION, modelProfile: scope.modelProfile };
        const skillSnapshot = (await skills.loadTaskSnapshot(skillScope).catch(() => [])).filter(spec => !revokedSkills.has(skillHash(spec)));
        const skillUsage = new SkillUsageTracker();
        let episode;
        const runDiagnostics = [];
        const usedExperiences = new Set();
        run.client = input.mode === 'wireless' ? createWirelessClient(wireless.forDevice(input.deviceId)) : await createUsbClient({ adbPath: await adbPath(), serial: input.serial });
        if (controller.signal.aborted) throw new ClientError('CANCELLED', '操作已取消。');
        result = await runAgent({ task: input.task, model, modelFetch, tools: run.client.tools, execute: (name, args, signal) => run.client.execute(name, args, signal), signal: controller.signal, onEvent, maxTurns: 24,
          diagnosticVersion: app.getVersion(), learningSnapshot, skillSnapshot,
          onSkillUsed: hashes => skillUsage.onUsed(hashes),
          onSkillTrace: step => skillUsage.onTrace(step),
          onFailureEpisode: value => { episode = value; }, onExperienceUsed: ids => ids.forEach(id => usedExperiences.add(id)),
          onDiagnostic: event => { void diagnostics.append(event); if (runDiagnostics.length < 500) runDiagnostics.push(event); } });
        // Revoke before another foreground task can load its frozen snapshot.
        // A completed model answer is not independent proof of semantic success.
        const skillOutcome = skillUsage.finish({ status: result.status, errorCode: result.error });
        skillOutcome.failedSkillHashes.forEach(hash => revokedSkills.add(hash));
        if (skillOutcome.failedSkillHashes.length) await skills.recordUsageOutcome(skillOutcome.failedSkillHashes.slice(0, 3), 'failure').catch(() => {});
        if (episode && !improvementStopped) await skills.recordEpisode(episode).catch(() => {});
        // The earlier fixed-strategy store remains compatible with developer tools.
        // Failure conservatively disables advice for the next task; completed
        // alone is not an independent success signal and never trains a success.
        if (result.status === 'failed') {
          usedExperiences.forEach(id => disabledExperiences.add(id));
          await Promise.allSettled([...usedExperiences].map(id => learning.recordOutcome(id, 'failure')));
        }
        void (async () => {
          const candidates = await summarizeCandidates(runDiagnostics, { hostVersion: app.getVersion(), ...scope });
          if (candidates.length) await learning.addCandidates(candidates);
        })().catch(() => {});
      }
      send({ type: 'run_finished', demo, status: result.status, answer: result.answer || '', metrics: result.metrics, ...(result.error ? { error: runtimeError(result.error) } : {}) });
    } catch (error) {
      send({ type: 'run_finished', demo, status: controller.signal.aborted ? 'cancelled' : 'failed', answer: '', error: { code: error.code || 'CLIENT_ERROR', message: safeMessage(error) } });
    } finally {
      await run.client?.close().catch(() => {});
      if (active === run) active = undefined;
      send({ type: 'idle' });
      if (!improvementStopped && !active && !modelTest && !savingConfig && !managingSkills) improver.schedule();
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
  improvementStopped = true;
  void improver.cancel().catch(() => {});
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
  learning = new LearningStore(app.getPath('userData'));
  skills = new SkillStore(app.getPath('userData'));
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
  improver = new ContinuousImprover({ store: skills, modelFetch,
    android: process.env.TAPPILOT_SKILL_EMULATOR ? { serial: process.env.TAPPILOT_SKILL_EMULATOR,
      adbPath: process.env.ADB_PATH || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb') } : undefined,
    resolveModel: () => {
    if (active || stopping || modelTest || savingConfig || managingSkills || improvementStopped) return undefined;
    try { return store.model(); } catch { return undefined; }
  }, onStatus: improvement => send({ type: 'improvement_state', improvement }) });
  handle('state', async () => ({ improvement: await improver.status().catch(() => ({ enabled: false, phase: 'error', activeSkills: 0, queued: 0, dailyJobs: 0, dailyModelCalls: 0 })), config: store.public(), running: Boolean(active), version: app.getVersion(), startupError, wireless: wireless.status() }));
  handle('save-config', async value => {
    if (active || savingConfig || modelTest || managingSkills) throw new ClientError('RUNNING', '请等待任务或配置保存结束。');
    savingConfig = true;
    try { await improver.pause(); return await store.save(value); } finally { savingConfig = false; if (!improvementStopped) improver.schedule(); }
  });
  handle('test-model', async () => {
    if (active || modelTest || savingConfig || managingSkills) throw new ClientError('TEST_RUNNING', '请等待当前任务或模型测试结束。');
    const controller = new AbortController(); modelTest = controller;
    try { await improver.pause(); return await testModel(store.model(), controller.signal, modelFetch); } finally { modelTest = undefined; if (!improvementStopped && !active) improver.schedule(); }
  });
  handle('devices', async () => (await listUsbDevices(await adbPath())).map(({ serial, state, usb, emulator, model }) => ({ serial, state, usb, emulator, model })));
  handle('wireless-interfaces', () => wireless.interfaces());
  handle('wireless-start', value => {
    if (active || stopping) throw new ClientError('RUNNING', '请结束当前任务后配对手机。');
    return wireless.start(value);
  });
  handle('wireless-close', async () => { if (active?.target?.mode === 'wireless') { active.controller.abort(); improvementStopped = true; await improver.cancel(); } await wireless.close(); return { closed: true }; });
  handle('wireless-copy', () => { clipboard.writeText(wireless.pairingUri()); return { copied: true }; });
  handle('run', value => begin(value, false));
  handle('demo', () => begin(undefined, true));
  handle('cancel', async () => { active?.controller.abort(); modelTest?.abort(); improvementStopped = true; await improver.cancel(); return { cancelled: true }; });
  handle('improvement-set', async value => {
    if (managingSkills) throw new ClientError('RUNNING', '请等待技能保存完成。');
    object(value, ['enabled']);
    if (typeof value.enabled !== 'boolean') throw new ClientError('INVALID_INPUT', '请指定是否开启自动改进。');
    if (value.enabled) improvementStopped = false;
    await improver.setEnabled(value.enabled);
    return improver.status();
  });
  handle('improvement-rollback', async () => {
    if (managingSkills) throw new ClientError('RUNNING', '请等待技能保存完成。');
    await improver.rollback(); send({ type: 'skills_changed' }); return improver.status();
  });
  handle('skills-list', () => skillRequest(async () => ({ items: await skills.listManagedSkills(), scope: currentSkillScope() })));
  handle('skills-create', value => {
    const input = skillInput(value), scope = currentSkillScope();
    if (!scope) throw new ClientError('MODEL_REQUIRED', '请先保存模型配置。');
    if (input.spec.scope.hostVersion !== scope.hostVersion || input.spec.scope.policyRevision !== scope.policyRevision || input.spec.scope.modelProfile !== scope.modelProfile)
      throw new ClientError('INVALID_INPUT', '请使用当前模型创建技能。');
    return mutateSkills(() => skills.createManagedSkill(input));
  });
  handle('skills-update', value => {
    const input = skillInput(value, true), id = skillId(value.id);
    return mutateSkills(() => skills.updateManagedSkill(id, input));
  });
  handle('skills-delete', value => {
    object(value, ['id']); const id = skillId(value.id);
    return mutateSkills(async () => { await skills.deleteManagedSkill(id); return { deleted: true }; });
  });
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
  if (!startupError) improver.schedule();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { improvementStopped = true; void improver?.cancel().catch(() => {}); active?.controller.abort(); modelTest?.abort(); void active?.client?.close(); void wireless?.close(); });
