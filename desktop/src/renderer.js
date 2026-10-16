/* All phone and model text is displayed as textContent, never executable markup. */
const $ = id => document.getElementById(id);
const api = window.tapPilot;
let config = { hasKey: false };
let selectedSerial = '';
let selectedName = '';
let running = false;
let demo = false;
let began = 0;
let clock;
let modelMs = 0;
let toolMs = 0;
let modelRequests = 0;
let toolCalls = 0;
const labels = { get_ui_tree: '读取当前界面', find_element: '定位界面控件', get_current_app: '确认前台应用', get_device_info: '读取设备状态', open_settings: '打开系统设置', click_element: '点击已观察到的控件', input_text: '在输入框填写文字', scroll: '滚动页面', swipe: '执行界面手势', press_key: '执行系统导航', wait_for_ui_change: '等待界面变化', act_and_observe: '执行操作并确认新界面', take_screenshot: '获取视觉补充', open_app: '打开应用' };

function page(name) {
  for (const item of document.querySelectorAll('.page')) item.hidden = item.id !== `page-${name}`;
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.page === name);
    if (item.dataset.page === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  $('page-title').textContent = { task: '任务', model: '模型', device: '设备' }[name];
}
function notice(message, error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
async function call(operation, value) {
  try {
    const result = await api[operation](value);
    if (!result.ok) { notice(`${result.error.message}${result.error.code ? ` (${result.error.code})` : ''}`, true); return null; }
    return result.result;
  } catch { notice('客户端连接异常，请重新打开 TapPilot。', true); return null; }
}
function showConfig(next) {
  config = next;
  $('base-url').value = next.baseUrl || '';
  $('model-name').value = next.model || '';
  $('api-key').value = '';
  $('clear-key').checked = false;
  $('adb-path').value = next.adbPath || '';
  $('key-status').textContent = next.hasKey ? '已加密保存' : '尚未保存';
  $('api-key').placeholder = next.hasKey ? '已保存 · 留空保留原密钥' : '输入密钥（本机无鉴权服务可留空）';
  $('model-label').textContent = next.model ? `◈  ${next.model}` : '先配置一个模型';
  selectedSerial ||= next.serial || '';
  updateDevice();
}
function updateDevice() {
  $('connection-label').textContent = selectedSerial ? selectedName || selectedSerial : '尚未选择手机';
  $('connection-dot').classList.toggle('muted', !selectedSerial);
  $('device-title').textContent = selectedSerial ? selectedName || '已选择 Android 手机' : '连接你的 Android';
  $('device-description').textContent = selectedSerial ? selectedSerial : '在设备页选择已授权的手机，即可开始执行任务。';
  $('phone-state').textContent = selectedSerial ? '已选择' : '等待连接';
}
function setRunning(value) {
  running = value;
  $('run-button').disabled = value;
  $('cancel-button').disabled = !value;
  $('demo-button').disabled = value;
  $('save-model').disabled = value;
  $('save-device').disabled = value;
  $('task-input').disabled = value;
}
function metrics(value) {
  $('metric-total').textContent = (value.totalMs / 1000).toFixed(1);
  $('metric-model').textContent = `${(value.modelMs / 1000).toFixed(1)} 秒`;
  $('metric-tool').textContent = `${(value.toolMs / 1000).toFixed(1)} 秒`;
  $('metric-rounds').textContent = `${value.modelRequests} / ${value.toolCalls}`;
}
function addStep(label, duration) {
  for (const item of $('timeline').children) item.classList.remove('current');
  const item = document.createElement('li'); item.className = 'current';
  const text = document.createElement('span'); text.textContent = label;
  const time = document.createElement('small'); time.textContent = duration === undefined ? '进行中' : `${(duration / 1000).toFixed(2)} 秒`;
  item.append(text, time); $('timeline').append(item);
  if ($('timeline').children.length > 120) $('timeline').firstChild.remove();
  $('timeline').scrollTop = $('timeline').scrollHeight;
}
function finishStep(duration) { const last = $('timeline').lastElementChild; if (last) { last.classList.remove('current'); last.lastElementChild.textContent = `${(duration / 1000).toFixed(2)} 秒`; } }
function resetRun(isDemo) {
  demo = isDemo; setRunning(true); notice('');
  $('demo-banner').hidden = !demo; $('empty-state').hidden = true;
  $('timeline').replaceChildren(); $('answer-panel').hidden = true; $('answer').textContent = '';
  $('run-badge').textContent = demo ? '演示中' : '运行中'; $('run-badge').className = 'badge running';
  began = performance.now(); modelMs = toolMs = modelRequests = toolCalls = 0;
  metrics({ totalMs: 0, modelMs: 0, toolMs: 0, modelRequests: 0, toolCalls: 0 });
  clearInterval(clock); clock = setInterval(() => { $('metric-total').textContent = ((performance.now() - began) / 1000).toFixed(1); }, 100);
}
api.onEvent(event => {
  if (event.type === 'run_started') resetRun(event.demo);
  else if (event.type === 'model_start') { modelRequests++; addStep(`第 ${event.turn || modelRequests} 轮 · 模型判断下一步`); }
  else if (event.type === 'model_end') { modelMs += event.durationMs || 0; finishStep(event.durationMs || 0); }
  else if (event.type === 'tool_start') { toolCalls++; addStep(labels[event.toolName] || `执行工具：${event.toolName}`); }
  else if (event.type === 'tool_end') { toolMs += event.durationMs || 0; finishStep(event.durationMs || 0); }
  else if (event.type === 'run_finished') {
    clearInterval(clock);
    $('run-badge').textContent = { completed: demo ? '演示完成' : '已完成', failed: '未完成', cancelled: '已取消' }[event.status] || '已结束';
    $('run-badge').className = `badge ${event.status === 'completed' ? 'done' : 'failed'}`;
    for (const item of $('timeline').children) item.classList.remove('current');
    $('answer-panel').hidden = false;
    $('answer-heading').textContent = demo ? '演示结果 · 合成数据' : '任务结果';
    $('answer').textContent = event.answer || event.error?.message || (event.status === 'cancelled' ? '任务已取消。已发出的手机动作可能已完成，请读取当前界面确认。' : '任务已结束。');
    if (event.metrics) metrics(event.metrics);
  } else if (event.type === 'idle') setRunning(false);
  else if (event.type === 'emergency_stopped') notice('手机已急停。恢复前请在手机 TapPilot 中手动允许自动化。');
  if (['model_end', 'tool_end'].includes(event.type)) metrics({ totalMs: performance.now() - began, modelMs, toolMs, modelRequests, toolCalls });
});

for (const element of document.querySelectorAll('[data-page]')) element.addEventListener('click', () => page(element.dataset.page));
for (const element of document.querySelectorAll('[data-goto]')) element.addEventListener('click', () => page(element.dataset.goto));
for (const element of document.querySelectorAll('[data-prompt]')) element.addEventListener('click', () => { if (!running) { $('task-input').value = element.dataset.prompt; $('task-input').focus(); } });
$('run-button').addEventListener('click', async () => {
  if (!config.model) { page('model'); notice('先保存模型地址、模型名称和 API Key。'); return; }
  if (!selectedSerial) { page('device'); notice('先选择用于本次任务的手机。'); return; }
  $('run-button').disabled = true;
  const result = await call('run', { task: $('task-input').value, serial: selectedSerial });
  if (!result) $('run-button').disabled = false;
});
$('demo-button').addEventListener('click', async () => { $('demo-button').disabled = true; if (!await call('demo')) $('demo-button').disabled = false; });
$('cancel-button').addEventListener('click', async () => { if (await call('cancel')) notice('正在取消任务，已发出的动作可能已经完成。'); });
$('emergency-button').addEventListener('click', async () => {
  $('emergency-button').disabled = true;
  const result = await call('emergencyStop', { serial: selectedSerial });
  if (result?.demo) notice('演示已停止，没有操作真实手机。');
  $('emergency-button').disabled = false;
});
function configInput() { return { baseUrl: $('base-url').value, model: $('model-name').value, apiKey: $('api-key').value, clearKey: $('clear-key').checked, adbPath: $('adb-path').value, serial: selectedSerial }; }
async function save() { const result = await call('saveConfig', configInput()); $('api-key').value = ''; if (result) { showConfig(result); notice('配置已保存到本机。'); } return result; }
$('model-form').addEventListener('submit', async event => { event.preventDefault(); await save(); });
$('save-device').addEventListener('click', save);
$('test-model').addEventListener('click', async () => {
  $('test-model').disabled = true; $('model-test-result').textContent = '正在保存配置并测试连接…';
  if (await save()) {
    const result = await call('testModel');
    $('model-test-result').textContent = result ? `连接成功 · ${result.model} · ${(result.durationMs / 1000).toFixed(2)} 秒` : '连接失败，请检查页面上方的错误信息。';
  } else $('model-test-result').textContent = '配置尚未保存。';
  $('test-model').disabled = false;
});
$('refresh-devices').addEventListener('click', async () => {
  $('refresh-devices').disabled = true;
  const devices = await call('devices');
  $('refresh-devices').disabled = false;
  if (!devices) return;
  $('device-list').replaceChildren();
  if (!devices.length) { const item = document.createElement('p'); item.className = 'subtle'; item.textContent = '未发现手机。请检查数据线、USB 调试和手机上的授权弹窗。'; $('device-list').append(item); }
  for (const device of devices) {
    const available = device.state === 'device' && device.usb && !device.emulator;
    const label = document.createElement('label'); label.className = `device-option ${available ? '' : 'unavailable'}`;
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'device'; radio.value = device.serial; radio.disabled = !available; radio.checked = available && selectedSerial === device.serial;
    const text = document.createElement('div'); const name = document.createElement('strong'); name.textContent = device.model?.replaceAll('_', ' ') || 'Android 手机';
    const detail = document.createElement('small'); detail.textContent = `${device.serial} · ${device.state === 'unauthorized' ? '请在手机上授权 USB 调试' : available ? 'USB 已连接' : device.state}`;
    text.append(name, detail); label.append(radio, text); $('device-list').append(label);
    radio.addEventListener('change', () => { selectedSerial = device.serial; selectedName = name.textContent; updateDevice(); notice('已选择设备。可以回到任务页开始执行。'); });
  }
});

void (async () => { const state = await call('state'); if (!state) return; showConfig(state.config); $('version').textContent = `TapPilot ${state.version}`; setRunning(state.running); if (state.startupError) notice(state.startupError, true); })();
