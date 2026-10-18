import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { isScreenshotReasonPair, screenshotFailureMessage } from '../../server/src/screenshot-errors';
import type { ClientEvent, ImprovementStatus, ConfigInput, ConnectionInput, ConnectionMode, LanAddress, Metrics, PageName, PairingResult, PublicConfig, Reply, UsbDevice, WirelessState, ManagedSkill, SkillInput, SkillScope } from './client-types';

const initialConfig: PublicConfig = { baseUrl: '', model: '', vision: false, hasKey: false, adbPath: '', serial: '', mode: 'wireless' };
const emptyWireless: WirelessState = { connected: false, closed: true, pairingAvailable: false };
const emptyMetrics: Metrics = { totalMs: 0, modelMs: 0, toolMs: 0, modelRequests: 0, toolCalls: 0 };
const labels: Record<string, string> = { get_ui_tree: '读取当前界面', find_element: '查找目标', observe_target: '查看目标', get_current_app: '查看当前应用', get_device_info: '读取设备状态', open_settings: '打开系统设置', click_element: '原生点击', tap_element: '点按目标', tap_visual: '看图点按', swipe_visual: '看图滑动', input_text: '输入文字', scroll: '滚动页面', swipe: '滑动屏幕', press_key: '系统导航', wait_for_ui_change: '等待界面变化', act_and_observe: '操作并查看结果', take_screenshot: '截图观察', open_app: '打开应用' };
const stepErrors: Record<string, string> = {
  UI_NOT_READY: '页面仍在加载，请稍后再试',
  STALE_SNAPSHOT: '界面已更新，目标已失效', NO_KNOWN_SNAPSHOT: '需要重新读取界面', READ_REQUIRED: '需要重新读取界面',
  TARGET_CHANGED: '目标已变化，未执行操作', GESTURE_CANCELLED: '手势被中断', GESTURE_COMPLETION_TIMEOUT: '未能确认手势完成',
  NODE_NOT_FOUND: '目标不存在', NODE_NOT_VISIBLE: '目标不可见', NODE_DISABLED: '目标已禁用', NODE_NOT_ACTIONABLE: '目标无法操作',
  NOT_CLICKABLE: '目标不可点击', NOT_EDITABLE: '目标无法输入', NOT_SCROLLABLE: '该区域无法滚动', ACTION_REJECTED: '手机未接受操作',
  DEVICE_LOCKED: '请先解锁手机', SERVICE_UNAVAILABLE: '无障碍服务未连接', EMERGENCY_STOPPED: '自动化已停止',
  WIRELESS_DISCONNECTED: '手机连接已断开', BRIDGE_UNAVAILABLE: '无法连接手机', PROTECTED_APP: '此页面需手动操作',
  SENSITIVE_FIELD: '此输入框需手动操作', PASSWORD_FIELD_BLOCKED: '密码需手动输入', CONFIRMATION_REQUIRED: '需要确认',
  COMMAND_TIMEOUT: '操作超时，请确认手机状态', WIRELESS_TIMEOUT: '连接超时，请确认手机状态', BRIDGE_TIMEOUT: '连接超时，请确认手机状态',
  INVALID_ARGUMENT: '操作参数无效', NOT_IMPLEMENTED: '暂不支持此操作', CANCELLED: '已取消',
  VISION_REQUIRED: '此页面需要支持图片的模型', MODEL_VISION_UNSUPPORTED: '模型不支持图片，请检查模型设置',
  SCREENSHOT_UNSUPPORTED: '此手机暂不支持截图观察', SCREENSHOT_PROTECTED: '截图受限，手机端未说明具体原因',
  SCREENSHOT_RATE_LIMITED: '截图过于频繁，请稍后再试', SCREENSHOT_TIMEOUT: '截图超时，请检查手机状态',
  SCREENSHOT_FAILED: '无法获取截图，请检查手机状态', SCREENSHOT_CONTEXT_CHANGED: '截图期间页面已切换，请重新读取',
  VISUAL_OBSERVATION_ONLY: '此截图只支持观察，当前步骤需手动操作', MODEL_IMAGE_LIMIT: '截图数据超出模型请求限制',
  VISUAL_REFERENCE_INVALID: '截图已失效，请重新观察', VISUAL_REFERENCE_EXPIRED: '截图已过期，请重新观察',
  VISUAL_CONTEXT_CHANGED: '页面已切换，未执行点按', VISUAL_SCENE_CHANGED: '画面已变化，未执行点按',
  VISUAL_TARGET_UNSAFE: '此目标需手动操作', VISUAL_ACTION_UNSUPPORTED: '此手机暂不支持看图点按',
  VISUAL_ACTION_UNAVAILABLE: '当前没有可用于点按的截图', VISUAL_NO_PROGRESS: '点按后未确认进展，已停止',
  VISUAL_OBSERVATION_FAILED: '点按后无法读取界面，请查看手机，不要重复点按',
  SCREENSHOT_LIMIT: '本次任务截图观察已达上限', SCREENSHOT_UNAVAILABLE: '无法获得截图，请检查手机端',
  NAVIGATION_EXHAUSTED: '连续查找已停止，请检查当前目标',
};
const stepReasons: Record<string, string> = {
  OBSERVATION_SETTLING: '页面仍在变化，未执行操作',
  INCOMPLETE_TREE: '界面信息不完整，需要重新读取',
  INVALID_HIERARCHY: '目标层级不完整，无法确认位置',
  TARGET_DISABLED: '目标已禁用',
  TARGET_HIDDEN: '目标当前不可见',
  SENSITIVE_TARGET: '此目标需手动操作',
  NO_CLICKABLE_TARGET: '目标及上层控件均不可点击',
  HIDDEN_ANCESTOR: '目标所在区域不可见',
  INVALID_BOUNDS: '目标没有有效触控区域',
  TARGET_CLIPPED: '目标超出可见区域',
  AMBIGUOUS_TOUCH_TARGET: '触控区域重叠，无法确定目标',
  TOUCH_TARGET_MISMATCH: '触控位置与目标不一致',
  WINDOW_OBSCURED: '目标被其他窗口遮挡',
  EXECUTOR_UPGRADE_REQUIRED: '请安装配套的新版手机端',
  TREE_INCOMPLETE: '刷新后的界面信息不完整',
  SESSION_CHANGED: '手机连接状态已变化',
  WINDOW_CHANGED: '当前页面已切换',
  TARGET_IDENTITY_CHANGED: '目标内容或状态已变化',
  TARGET_AMBIGUOUS: '出现多个相似目标，无法确定',
  PAGE_CONTEXT_CHANGED: '目标所在页面内容已变化',
  TARGET_NOT_ACTIONABLE: '刷新后的目标无法操作',
  SNAPSHOT_MISSING: '界面记录已失效，需要重新读取',
  TREE_STRUCTURE_CHANGED: '页面布局已变化',
  NODE_CONTENT_CHANGED: '页面内容已变化',
  NODE_BOUNDS_CHANGED: '控件位置已变化',
  NODE_STATE_CHANGED: '控件状态已变化',
  NODE_UNAVAILABLE: '控件已不可访问',
};
const toolLabel = (event: ClientEvent) => event.toolName === 'navigate_until' ? '连续滑动查找' : labels[event.action || event.toolName || ''] || '执行手机操作';
function stepResult(event: ClientEvent): string | undefined {
  if (event.ok === false) {
    const reason = isScreenshotReasonPair(event.errorCode, event.errorReason)
      ? screenshotFailureMessage(event.errorCode, event.errorReason)
      : event.errorReason && Object.hasOwn(stepReasons, event.errorReason) ? stepReasons[event.errorReason] : undefined;
    return event.errorCode ? `${reason || stepErrors[event.errorCode] || '操作失败'} (${event.errorCode})` : reason || '操作失败';
  }
  if (typeof event.navigationSteps === 'number') {
    const reason = ({ target_found: '已找到目标', target_candidate: '发现相关入口，等待确认', already_explored: '此方向已查找过',
      max_steps: '本次未找到目标', no_progress: '页面没有继续变化',
      scope_changed: '页面已切换，尚未找到目标', observation_unavailable: '需要重新观察', target_ambiguous: '出现多个目标',
      target_blocked: '目标暂不可用', container_unavailable: '区域暂不可用' } as Record<string, string>)[event.navigationStopReason || ''] || '已停止';
    return `已滑动 ${event.navigationSteps} 次 · ${reason}`;
  }
  if (event.observationChanged === false) return '界面未变化';
  return undefined;
}
export interface RunStep { id: string; label: string; active: boolean; failed?: boolean; result?: string; durationMs?: number }
interface RunState { phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'; demo: boolean; answer: string; error?: ClientEvent['error']; metrics: Metrics; steps: RunStep[] }
const initialRun: RunState = { phase: 'idle', demo: false, answer: '', metrics: emptyMetrics, steps: [] };
function runReducer(state: RunState, event: ClientEvent): RunState {
  if (event.type === 'run_started') return { ...initialRun, phase: 'running', demo: Boolean(event.demo), metrics: { ...emptyMetrics } };
  if (event.type === 'tick') return { ...state, metrics: { ...state.metrics, totalMs: event.durationMs || 0 } };
  if (event.type === 'model_correction') return { ...state, steps: [...state.steps.map(step => ({ ...step, active: false })), {
    id: `correction-${event.turn}`, label: '正在纠正操作格式', active: false,
  }].slice(-120) };
  if (event.type === 'model_start' || event.type === 'tool_start') {
    const model = event.type === 'model_start';
    const metrics = { ...state.metrics, modelRequests: state.metrics.modelRequests + Number(model), toolCalls: state.metrics.toolCalls + Number(!model) };
    return { ...state, metrics, steps: [...state.steps.map(step => ({ ...step, active: false })), { id: `${metrics.modelRequests}-${metrics.toolCalls}`, label: model ? `第 ${event.turn || metrics.modelRequests} 轮 · 思考中` : toolLabel(event), active: true }].slice(-120) };
  }
  if (event.type === 'model_end' || event.type === 'tool_end') {
    const field = event.type === 'model_end' ? 'modelMs' : 'toolMs';
    return { ...state, metrics: { ...state.metrics, [field]: state.metrics[field] + (event.durationMs || 0) }, steps: state.steps.map((step, index) => index === state.steps.length - 1 ? {
      ...step, active: false, durationMs: event.durationMs || 0,
      ...(event.type === 'tool_end' ? { label: toolLabel(event), failed: event.ok === false, result: stepResult(event) } : {}),
    } : step) };
  }
  if (event.type === 'run_finished') return { ...state, phase: event.status || 'failed', error: event.error,
    answer: event.answer || (event.error ? '' : event.status === 'cancelled' ? '任务已取消，请在手机确认最后一步的结果。' : '任务已结束。'),
    metrics: event.metrics || state.metrics, steps: state.steps.map(step => ({ ...step, active: false })) };
  return state;
}

export function useClient() {
  const api = window.tapPilot;
  const [page, setPage] = useState<PageName>('task');
  const [config, setConfig] = useState(initialConfig);
  const [draft, setDraft] = useState({ baseUrl: '', model: '', vision: false, apiKey: '', adbPath: '', clearKey: false });
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState('');
  const [notice, setNotice] = useState({ text: '', error: false });
  const [mode, setMode] = useState<ConnectionMode>('wireless');
  const [selectedSerial, setSelectedSerial] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [selectedWirelessId, setSelectedWirelessId] = useState('');
  const [wireless, setWireless] = useState(emptyWireless);
  const [pairing, setPairing] = useState<PairingResult | null>(null);
  const [pairingSeconds, setPairingSeconds] = useState(0);
  const [addresses, setAddresses] = useState<LanAddress[]>([]);
  const [lanAddress, setLanAddress] = useState('');
  const [lanLoaded, setLanLoaded] = useState(false);
  const [devices, setDevices] = useState<UsbDevice[] | null>(null);
  const [task, setTask] = useState('');
  const [running, setRunning] = useState(false);
  const [runPending, setRunPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [improvement, setImprovement] = useState<ImprovementStatus>({ enabled: false, phase: 'idle', activeSkills: 0, queued: 0, dailyJobs: 0, dailyModelCalls: 0 });
  const [improvementBusy, setImprovementBusy] = useState(false);
  const [skillItems, setSkillItems] = useState<ManagedSkill[]>([]);
  const [skillScope, setSkillScope] = useState<SkillScope>();
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsRevision, setSkillsRevision] = useState(0);
  const skillsReadId = useRef(0);
  const [modelTestResult, setModelTestResult] = useState('');
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [lanLoading, setLanLoading] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [run, dispatch] = useReducer(runReducer, initialRun);
  const began = useRef(0);
  const current = useRef({ mode, running, wireless });
  current.current = { mode, running, wireless };
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  const request = useCallback(async <T,>(action: () => Promise<Reply<T>>): Promise<T | null> => {
    try {
      const reply = await action();
      if (!reply.ok) { notify(`${reply.error.message}${reply.error.code ? ` (${reply.error.code})` : ''}`, true); return null; }
      return reply.result;
    } catch { notify('客户端连接异常，请重新打开 TapPilot。', true); return null; }
  }, [notify]);
  const showConfig = useCallback((next: PublicConfig) => {
    setConfig(next);
    setDraft({ baseUrl: next.baseUrl || '', model: next.model || '', vision: next.vision === true, apiKey: '', adbPath: next.adbPath || '', clearKey: false });
    setSelectedSerial(previous => previous || next.serial || '');
    setMode(next.mode || 'usb');
  }, []);
  const showWireless = useCallback((next: WirelessState) => {
    if (current.current.wireless.connected && !next.connected && current.current.running && current.current.mode === 'wireless') notify('手机已断开，任务已停止，不会自动重做。', true);
    setWireless(next);
    setSelectedWirelessId(previous => next.closed || previous && next.deviceId !== previous ? '' : previous);
    if (!next.pairingAvailable) setPairing(null);
  }, [notify]);
  useEffect(() => {
    let disposed = false;
    const unsubscribe = api.onEvent(event => {
      if (event.type === 'run_started') { began.current = performance.now(); setRunning(true); setRunPending(false); notify(''); }
      if (event.type === 'idle') { setRunning(false); setRunPending(false); }
      if (event.type === 'emergency_stopped') notify('已急停。请在手机 TapPilot 中恢复自动化后继续。');
      if (event.type === 'improvement_state' && event.improvement) {
        setImprovement(event.improvement);
        setSkillsRevision(value => value + 1);
      }
      if (event.type === 'skills_changed') setSkillsRevision(value => value + 1);
      if (event.type === 'wireless_state' && event.state) showWireless(event.state);
      dispatch(event);
    });
    void request(() => api.state()).then(state => {
      if (!state || disposed) return;
      showConfig(state.config); showWireless(state.wireless); setVersion(state.version); setRunning(state.running); setReady(true);
      if (state.improvement) setImprovement(state.improvement);
      if (state.startupError) notify(state.startupError, true);
    });
    return () => { disposed = true; unsubscribe(); };
  }, [api, request, showConfig, showWireless, notify]);
  const refreshSkills = useCallback(async () => {
    const readId = ++skillsReadId.current;
    setSkillsLoading(true);
    const result = await request(() => api.listSkills());
    if (readId !== skillsReadId.current) return;
    if (result) { setSkillItems(result.items); setSkillScope(result.scope); }
    setSkillsLoading(false);
  }, [api, request]);
  useEffect(() => {
    if (ready && page === 'improvement') void refreshSkills();
  }, [ready, page, skillsRevision, refreshSkills]);
  useEffect(() => {
    if (run.phase !== 'running') return;
    const timer = window.setInterval(() => dispatch({ type: 'tick', durationMs: performance.now() - began.current }), 100);
    return () => window.clearInterval(timer);
  }, [run.phase]);
  useEffect(() => {
    if (!pairing) return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil(((wireless.pairingExpiresAt || 0) - Date.now()) / 1000));
      setPairingSeconds(seconds);
      if (!seconds) setPairing(null);
    };
    update(); const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [pairing, wireless.pairingExpiresAt]);

  const refreshLAN = useCallback(async () => {
    setLanLoading(true);
    const found = await request(() => api.wirelessInterfaces());
    setLanLoading(false);
    if (!found) return;
    setAddresses(found); setLanLoaded(true); setLanAddress(previous => found.some(item => item.address === previous) ? previous : found[0]?.address || '');
  }, [api, request]);
  useEffect(() => { if (ready && page === 'device' && mode === 'wireless' && !lanLoaded) void refreshLAN(); }, [page, mode, ready, lanLoaded, refreshLAN]);
  const connectionInput = (): ConnectionInput => mode === 'wireless' ? { mode, deviceId: selectedWirelessId } : { mode, serial: selectedSerial };
  const connected = mode === 'wireless' ? wireless.connected && selectedWirelessId === wireless.deviceId : Boolean(selectedSerial);
  const deviceName = connected ? (mode === 'wireless' ? wireless.deviceName : selectedName || selectedSerial) || 'Android 手机' : '选择手机';
  const busy = running || runPending;
  const save = async () => {
    setSaving(true);
    const input: ConfigInput = { ...draft, serial: selectedSerial, mode };
    const result = await request(() => api.saveConfig(input));
    setDraft(previous => ({ ...previous, apiKey: '' })); setSaving(false);
    if (result) { showConfig(result); notify('已保存。'); }
    return result;
  };
  const startRun = async (text: string) => {
    if (busy) return;
    if (!config.model) { setPage('model'); notify('请先填写并保存模型配置。'); return; }
    if (!connected) { setPage('device'); notify('请先连接并选择手机。'); return; }
    setRunPending(true);
    if (!await request(() => api.run({ task: text, ...connectionInput() }))) setRunPending(false);
  };
  const startDemo = async () => {
    if (busy) return;
    setRunPending(true);
    if (!await request(() => api.demo())) setRunPending(false);
  };
  const cancel = async () => { if (await request(() => api.cancel())) notify('正在取消，请在手机确认最后一步的结果。'); };
  const emergency = async () => {
    setStopping(true);
    const result = await request(() => api.emergencyStop(connectionInput()));
    if (result?.demo) notify('演示已停止，没有操作真实手机。');
    setStopping(false);
  };
  const testModel = async () => {
    setTesting(true); setModelTestResult('正在测试连接…');
    if (await save()) {
      const result = await request(() => api.testModel());
      setModelTestResult(result ? `连接成功 · ${result.model} · ${(result.durationMs / 1000).toFixed(2)} 秒` : '连接失败，请查看上方提示。');
    } else setModelTestResult('请先保存配置。');
    setTesting(false);
  };
  const toggleImprovement = async () => {
    setImprovementBusy(true);
    const result = await request(() => api.setImprovement({ enabled: !improvement.enabled }));
    if (result) setImprovement(result);
    setImprovementBusy(false);
  };
  const rollbackImprovement = async () => {
    setImprovementBusy(true);
    const result = await request(() => api.rollbackImprovement());
    if (result) { setImprovement(result); notify('已撤回当前改进，后续任务生效。'); }
    setImprovementBusy(false);
  };
  const createSkill = async (value: SkillInput): Promise<ManagedSkill | null> => {
    setSkillsBusy(true);
    try {
      const result = await request(() => api.createSkill(value));
      if (result) { notify('已保存，验证通过后生效。'); await refreshSkills(); }
      return result;
    } finally { setSkillsBusy(false); }
  };
  const updateSkill = async (id: string, value: SkillInput): Promise<ManagedSkill | null> => {
    setSkillsBusy(true);
    try {
      const result = await request(() => api.updateSkill({ id, ...value }));
      if (result) { notify(['draft', 'candidate'].includes(result.state) ? '已保存修改，验证通过后生效。' : '已保存技能名称。'); await refreshSkills(); }
      return result;
    } finally { setSkillsBusy(false); }
  };
  const deleteSkill = async (id: string): Promise<boolean> => {
    setSkillsBusy(true);
    try {
      const result = await request(() => api.deleteSkill({ id }));
      if (result) { notify('已删除技能。'); await refreshSkills(); }
      return result?.deleted === true;
    } finally { setSkillsBusy(false); }
  };
  const refreshDevices = async () => {
    setDevicesLoading(true); const found = await request(() => api.devices()); setDevicesLoading(false);
    if (found) setDevices(found);
  };
  const selectUsb = (device: UsbDevice) => {
    if (busy || device.state !== 'device' || !device.usb || device.emulator) return;
    setSelectedSerial(device.serial); setSelectedName(device.model?.replaceAll('_', ' ') || 'Android 手机'); notify('已选择手机，可开始任务。');
  };
  const startPairing = async () => {
    setPairingBusy(true); notify('正在生成二维码…');
    const result = await request(() => api.wirelessStart({ host: lanAddress }));
    setPairingBusy(false);
    if (!result) return;
    showWireless(result.status); notify('请用手机 TapPilot 扫码。');
    if (result.status.pairingAvailable) setPairing(result);
  };
  const stopPairing = async () => {
    setPairingBusy(true);
    if (await request(() => api.wirelessClose())) { setPairing(null); notify('已断开，再次连接请重新扫码。'); }
    setPairingBusy(false);
  };
  const copyPairing = async () => { if (await request(() => api.wirelessCopy())) notify('已复制，请粘贴到你自己的手机 TapPilot。'); };
  const selectWireless = () => {
    if (!busy && wireless.connected && wireless.deviceId) { setSelectedWirelessId(wireless.deviceId); setMode('wireless'); notify('已选择手机，可开始任务。'); }
  };
  return { skillItems, skillScope, skillsLoading, skillsBusy, refreshSkills, createSkill, updateSkill, deleteSkill, improvement, improvementBusy, toggleImprovement, rollbackImprovement, page, setPage, config, draft, setDraft, ready, version, notice, mode, setMode, selectedSerial, selectedWirelessId, wireless, pairing, pairingSeconds, addresses, lanAddress, setLanAddress, lanLoaded, devices, task, setTask, busy, running, run, saving, testing, modelTestResult, devicesLoading, lanLoading, pairingBusy, stopping, connected, deviceName, refreshLAN, save, startRun, startDemo, cancel, emergency, testModel, refreshDevices, selectUsb, startPairing, stopPairing, copyPairing, selectWireless };
}
export type ClientController = ReturnType<typeof useClient>;
