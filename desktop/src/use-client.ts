import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ClientEvent, ConfigInput, ConnectionInput, ConnectionMode, LanAddress, Metrics, PageName, PairingResult, PublicConfig, Reply, UsbDevice, WirelessState } from './client-types';

const initialConfig: PublicConfig = { baseUrl: '', model: '', hasKey: false, adbPath: '', serial: '', mode: 'wireless' };
const emptyWireless: WirelessState = { connected: false, closed: true, pairingAvailable: false };
const emptyMetrics: Metrics = { totalMs: 0, modelMs: 0, toolMs: 0, modelRequests: 0, toolCalls: 0 };
const labels: Record<string, string> = { get_ui_tree: '读取当前界面', find_element: '查找目标', get_current_app: '查看当前应用', get_device_info: '读取设备状态', open_settings: '打开系统设置', click_element: '点击目标', input_text: '输入文字', scroll: '滚动页面', swipe: '滑动屏幕', press_key: '系统导航', wait_for_ui_change: '等待界面变化', act_and_observe: '操作并查看结果', take_screenshot: '查看截图', open_app: '打开应用' };
export interface RunStep { id: string; label: string; active: boolean; durationMs?: number }
interface RunState { phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'; demo: boolean; answer: string; metrics: Metrics; steps: RunStep[] }
const initialRun: RunState = { phase: 'idle', demo: false, answer: '', metrics: emptyMetrics, steps: [] };
function runReducer(state: RunState, event: ClientEvent): RunState {
  if (event.type === 'run_started') return { ...initialRun, phase: 'running', demo: Boolean(event.demo), metrics: { ...emptyMetrics } };
  if (event.type === 'tick') return { ...state, metrics: { ...state.metrics, totalMs: event.durationMs || 0 } };
  if (event.type === 'model_start' || event.type === 'tool_start') {
    const model = event.type === 'model_start';
    const metrics = { ...state.metrics, modelRequests: state.metrics.modelRequests + Number(model), toolCalls: state.metrics.toolCalls + Number(!model) };
    return { ...state, metrics, steps: [...state.steps.map(step => ({ ...step, active: false })), { id: `${metrics.modelRequests}-${metrics.toolCalls}`, label: model ? `第 ${event.turn || metrics.modelRequests} 轮 · 思考中` : labels[event.toolName || ''] || `执行工具：${event.toolName}`, active: true }].slice(-120) };
  }
  if (event.type === 'model_end' || event.type === 'tool_end') {
    const field = event.type === 'model_end' ? 'modelMs' : 'toolMs';
    return { ...state, metrics: { ...state.metrics, [field]: state.metrics[field] + (event.durationMs || 0) }, steps: state.steps.map((step, index) => index === state.steps.length - 1 ? { ...step, active: false, durationMs: event.durationMs || 0 } : step) };
  }
  if (event.type === 'run_finished') return { ...state, phase: event.status || 'failed', answer: event.answer || event.error?.message || (event.status === 'cancelled' ? '任务已取消，请在手机确认最后一步的结果。' : '任务已结束。'), metrics: event.metrics || state.metrics, steps: state.steps.map(step => ({ ...step, active: false })) };
  return state;
}

export function useClient() {
  const api = window.tapPilot;
  const [page, setPage] = useState<PageName>('task');
  const [config, setConfig] = useState(initialConfig);
  const [draft, setDraft] = useState({ baseUrl: '', model: '', apiKey: '', adbPath: '', clearKey: false });
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
    setDraft({ baseUrl: next.baseUrl || '', model: next.model || '', apiKey: '', adbPath: next.adbPath || '', clearKey: false });
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
      if (event.type === 'wireless_state' && event.state) showWireless(event.state);
      dispatch(event);
    });
    void request(() => api.state()).then(state => {
      if (!state || disposed) return;
      showConfig(state.config); showWireless(state.wireless); setVersion(state.version); setRunning(state.running); setReady(true);
      if (state.startupError) notify(state.startupError, true);
    });
    return () => { disposed = true; unsubscribe(); };
  }, [api, request, showConfig, showWireless, notify]);
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
  return { page, setPage, config, draft, setDraft, ready, version, notice, mode, setMode, selectedSerial, selectedWirelessId, wireless, pairing, pairingSeconds, addresses, lanAddress, setLanAddress, lanLoaded, devices, task, setTask, busy, running, run, saving, testing, modelTestResult, devicesLoading, lanLoading, pairingBusy, stopping, connected, deviceName, refreshLAN, save, startRun, startDemo, cancel, emergency, testModel, refreshDevices, selectUsb, startPairing, stopPairing, copyPairing, selectWireless };
}
export type ClientController = ReturnType<typeof useClient>;
