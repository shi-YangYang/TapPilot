import { ArrowUpRight, Battery, Bot, Check, ChevronRight, Copy, Layers2, LockKeyhole, Moon, Play, RefreshCw, Smartphone, Square, Sun, Text, Usb, Wifi } from 'lucide-react';
import { PromptInput } from '@/components/agents/prompt-input';
import { AgentActivity, type AgentActivityItem } from '@/components/agents/agent-activity';
import { Button } from '@/components/motion/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/motion/card';
import { Input } from '@/components/motion/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs';
import { Tooltip, TooltipProvider } from '@/components/motion/tooltip';
import type { ConnectionMode, PageName } from './client-types';
import { useClient, type ClientController } from './use-client';
import { useTheme } from './use-theme';

const prompts = [
  { label: '查看电池', icon: Battery, text: '打开系统设置，进入电池页面，告诉我当前显示了什么。' },
  { label: '总结界面', icon: Text, text: '读取当前手机界面，简要总结当前可见内容，不进行任何点击。' },
];
function RunBadge({ client: c }: { client: ClientController }) {
  const text = { idle: '待开始', running: c.run.demo ? '演示中' : '运行中', completed: c.run.demo ? '演示完成' : '已完成', cancelled: '已取消', failed: '未完成' }[c.run.phase];
  return <span id="run-badge" className="run-status" data-phase={c.run.phase}>{text}</span>;
}
function TaskPage({ client: c }: { client: ClientController }) {
  const items: AgentActivityItem[] = c.run.steps.map(step => ({
    id: step.id, type: 'step',
    label: <span>{step.label}{step.failed && ' · 未完成'}{step.result && <span className="block text-xs text-muted-foreground">{step.result}</span>}</span>,
    status: step.active ? 'active' : step.failed ? 'pending' : 'complete',
    meta: step.durationMs === undefined ? undefined : `${(step.durationMs / 1000).toFixed(2)} 秒`,
  }));
  const finished = c.run.phase !== 'idle' && c.run.phase !== 'running';
  const summary = { idle: '任务进度', running: '正在执行', completed: '已完成', cancelled: '已取消', failed: '未完成' }[c.run.phase];
  const { modelRequestBytes, modelUiBytes, rawUiBytes, hostReads } = c.run.metrics;
  const uiReduction = rawUiBytes !== undefined && rawUiBytes > 0 && modelUiBytes !== undefined ? Math.max(0, Math.min(100, Math.round((1 - modelUiBytes / rawUiBytes) * 100))) : undefined;
  return <section id="page-task" className="task-page" data-phase={c.run.phase} hidden={c.page !== 'task'}>
    <div className="page-heading task-heading"><div><p className="section-eyebrow">新任务</p><h1>想让手机做什么？</h1></div><span hidden={c.run.phase === 'idle'}><RunBadge client={c} /></span></div>
    <div id="demo-banner" className="demo-notice" hidden={!c.run.demo}>演示模式 · 模拟数据，不操作手机或调用模型。</div>
    <PromptInput
      id="task-input" aria-label="手机任务" value={c.task} onValueChange={c.setTask}
      placeholder="描述你想完成的事…" maxLength={8000} minRows={3} className="task-composer"
      loading={c.busy} readOnly={c.busy} disabled={!c.ready}
      onSubmit={c.startRun} onStop={() => void c.cancel()}
      submitId="run-button" stopId="cancel-button" submitAriaLabel="开始任务" stopAriaLabel="取消任务"
      leadingAction={<div className="prompt-context">
        <Tooltip content="配置模型服务"><Button variant="ghost" size="sm" data-goto="model" onClick={() => c.setPage('model')} className="max-w-52 min-w-0"><Bot className="size-3.5 shrink-0" /><span id="model-label" className="truncate">{c.config.model || '配置模型'}</span></Button></Tooltip>
        <Tooltip content={c.connected ? '查看手机连接' : '连接并选择手机'}><Button variant="ghost" size="sm" data-goto="device" onClick={() => c.setPage('device')} className="max-w-44 min-w-0"><Smartphone className="size-3.5 shrink-0" /><span id="device-title" className="truncate">{c.deviceName}</span>{c.connected && <Check className="size-3 shrink-0" />}</Button></Tooltip>
      </div>}
    />
    <p className="privacy-caption">开始后会操作手机，并将必要的界面信息发送给所选模型。</p>
    <div className="suggestion-heading"><span>快速开始</span><Button id="demo-button" variant="ghost" size="sm" disabled={!c.ready || c.busy} onClick={() => void c.startDemo()}><Play className="size-3" />体验演示</Button></div>
    <div className="task-suggestions">
      {prompts.map(({ label, icon: Icon, text }) => <Button key={label} variant="ghost" className="suggestion-card" data-prompt={text} disabled={c.busy} onClick={() => c.setTask(text)}><span className="suggestion-icon"><Icon className="size-4" /></span><span>{label}</span><ArrowUpRight className="size-3.5 suggestion-arrow" /></Button>)}
    </div>
    {c.run.phase !== 'idle' && <div id="timeline" className="task-activity" aria-live="polite">
      <AgentActivity items={items} status={c.run.phase === 'running' ? 'working' : 'complete'} duration={c.run.metrics.totalMs / 1000} activeLabel="正在处理任务…" summary={`${summary} · ${(c.run.metrics.totalMs / 1000).toFixed(1)} 秒`} maxHeight={208} />
    </div>}
    <div id="answer-panel" className="task-answer" hidden={!finished}><h2 id="answer-heading">{c.run.demo ? '演示结果 · 合成数据' : '任务结果'}</h2><div id="answer">{c.run.answer}</div></div>
    {c.run.phase !== 'idle' && <details className="help-details metrics-details"><summary>耗时明细</summary><dl>
      <div><dt>总耗时</dt><dd><span id="metric-total">{(c.run.metrics.totalMs / 1000).toFixed(1)}</span> 秒</dd></div>
      <div><dt>模型思考</dt><dd id="metric-model">{(c.run.metrics.modelMs / 1000).toFixed(1)} 秒</dd></div>
      <div><dt>手机操作</dt><dd id="metric-tool">{(c.run.metrics.toolMs / 1000).toFixed(1)} 秒</dd></div>
      <div><dt>请求 / 工具调用</dt><dd id="metric-rounds">{c.run.metrics.modelRequests} / {c.run.metrics.toolCalls}</dd></div>
      {modelRequestBytes !== undefined && <div><dt>模型请求数据</dt><dd id="metric-payload">{(modelRequestBytes / 1024).toFixed(1)} KiB</dd></div>}
      {uiReduction !== undefined && <div><dt>界面数据压缩</dt><dd id="metric-ui-reduction">减少 {uiReduction}% · {((rawUiBytes || 0) / 1024).toFixed(1)} → {((modelUiBytes || 0) / 1024).toFixed(1)} KiB</dd></div>}
      {hostReads !== undefined && <div><dt>自动观察</dt><dd id="metric-host-reads">{hostReads} 次</dd></div>}
    </dl></details>}
  </section>;
}
function ModelPage({ client: c }: { client: ClientController }) {
  const locked = c.busy || c.saving || c.testing || !c.ready;
  const field = (name: 'baseUrl' | 'model' | 'apiKey' | 'adbPath', value: string) => c.setDraft(previous => ({ ...previous, [name]: value }));
  return <section id="page-model" className="settings-page" hidden={c.page !== 'model'}>
    <div className="page-heading"><h1>模型设置</h1><p>连接你习惯使用的模型服务。</p></div>
    <form id="model-form" onSubmit={event => { event.preventDefault(); void c.save(); }}>
      <Card className="settings-card">
        <CardHeader><CardTitle as="h2">连接信息</CardTitle><CardDescription>使用支持工具调用的 OpenAI 兼容接口。</CardDescription></CardHeader>
        <CardContent className="form-fields">
          <Input id="base-url" label="API 地址" type="url" value={c.draft.baseUrl} onChange={value => field('baseUrl', value)} placeholder="https://api.example.com/v1" maxLength={2048} autoComplete="off" required disabled={locked} />
          <Input id="model-name" label="模型名称" value={c.draft.model} onChange={value => field('model', value)} placeholder="填写服务商提供的模型 ID" maxLength={200} autoComplete="off" required disabled={locked} />
          <div><Input id="api-key" label="API Key" type="password" value={c.draft.apiKey} onChange={value => field('apiKey', value)} placeholder={c.config.hasKey ? '留空保留已保存密钥' : '输入密钥'} maxLength={8192} autoComplete="new-password" disabled={locked} /><div className="key-details"><span id="key-status">{c.config.hasKey ? '已加密保存' : '尚未保存'}</span><label><input id="clear-key" type="checkbox" checked={c.draft.clearKey} onChange={event => c.setDraft(previous => ({ ...previous, clearKey: event.target.checked }))} disabled={locked} />清除密钥</label></div></div>
        </CardContent>
        <CardFooter className="form-footer"><span className="local-key"><LockKeyhole className="size-3.5" />密钥加密保存在本机</span><Button id="test-model" variant="outline" disabled={locked} onClick={() => void c.testModel()}>{c.testing ? '测试中…' : '测试连接'}</Button><Button id="save-model" type="submit" disabled={locked}>{c.saving ? '保存中…' : '保存'}</Button></CardFooter>
        {c.modelTestResult && <CardContent><p id="model-test-result" className="inline-result" role="status">{c.modelTestResult}</p></CardContent>}
      </Card>
    </form>
    <p className="privacy-caption">任务和必要的手机界面信息会发送到此服务。</p>
    <details className="help-details"><summary>填写说明</summary><p>同一服务的密钥留空可保留。更换地址的域名或端口会清除旧密钥，请填写新服务的密钥。</p><p>本机模型可用 http://localhost:端口/v1，无鉴权时密钥可留空。测试连接成功后，可先运行“总结界面”。</p></details>
  </section>;
}
function WirelessPanel({ client: c }: { client: ClientController }) {
  const state = c.wireless;
  const stateLabel = state.connected ? '已连接' : state.paired ? '等待重连' : state.closed ? '尚未开启' : state.pairingAvailable ? '等待扫码' : '已过期';
  const hint = state.closed ? '在手机 TapPilot 中开启无障碍服务并允许自动化。' : state.connected ? '保持手机解锁，然后回到任务页。' : state.paired ? '请在手机重新连接，再开始任务。' : state.pairingAvailable ? '打开手机 TapPilot 扫码。' : '二维码已过期，请断开后重新生成。';
  return <div id="wireless-panel" hidden={c.mode !== 'wireless'}><Card className="settings-card">
    <CardHeader><CardTitle as="h2">无线连接</CardTitle><CardDescription>电脑和手机连接同一个 Wi-Fi。</CardDescription><CardAction><span id="wireless-badge" className="run-status" data-phase={state.connected ? 'completed' : 'idle'}>{stateLabel}</span></CardAction></CardHeader>
    <CardContent>
      <div className="network-row"><div id="lan-address" role="group" aria-label="电脑地址" className="network-select"><Select value={c.lanAddress} onValueChange={c.setLanAddress} disabled={!state.closed || c.busy || c.pairingBusy || !c.addresses.length}><SelectTrigger><SelectValue placeholder={c.lanLoading ? '读取网络地址…' : '选择电脑地址'} /></SelectTrigger><SelectContent>{c.addresses.map(item => <SelectItem key={item.address} value={item.address}>{`${item.address} · ${item.name}`}</SelectItem>)}</SelectContent></Select></div><Tooltip content="刷新网络地址"><Button id="refresh-lan" variant="ghost" size="icon" aria-label="刷新网络地址" disabled={c.lanLoading || !state.closed || c.busy} onClick={() => void c.refreshLAN()}><RefreshCw className="size-4" /></Button></Tooltip></div>
      <p id="lan-hint" className="field-hint">{c.lanLoaded && !c.addresses.length ? '未发现网络，请连接 Wi-Fi 后刷新。' : '选择当前 Wi-Fi 的地址。'}</p>
      {c.pairing && <div id="pairing-panel" className="pairing-layout"><img id="pairing-qr" src={c.pairing.qrDataUrl} width="200" height="200" alt="TapPilot 配对二维码" /><div><h3>用手机 TapPilot 扫码</h3><p id="pairing-expiry">{Math.floor(c.pairingSeconds / 60)} 分 {String(c.pairingSeconds % 60).padStart(2, '0')} 秒后过期</p><Button id="copy-pairing" variant="outline" size="sm" onClick={() => void c.copyPairing()}><Copy className="size-3.5" />复制配对链接</Button><details className="help-details"><summary>手动输入链接</summary><textarea id="pairing-link" readOnly value={c.pairing.pairingUri} aria-label="配对链接" /></details><p className="field-hint">二维码仅供你自己的手机使用。</p></div></div>}
      <div id="wireless-device" className="paired-device" hidden={!state.paired}><Smartphone className="size-5" /><div><strong id="wireless-device-name">{state.deviceName || 'Android 手机'}</strong><p id="wireless-device-status">{state.connected ? '已加密连接' : '已断开，请重新连接'}</p></div><Button id="select-wireless" variant="outline" size="sm" disabled={!state.connected || c.busy} onClick={c.selectWireless}>{c.selectedWirelessId === state.deviceId ? '已选择' : '选择此手机'}</Button></div>
    </CardContent>
    <CardFooter><Button id="start-pairing" disabled={c.busy || !state.closed || c.pairingBusy || !c.lanAddress} onClick={() => void c.startPairing()}>{c.pairingBusy && state.closed ? '正在生成…' : '显示二维码'}</Button><Button id="stop-pairing" variant="outline" disabled={state.closed || c.pairingBusy} onClick={() => void c.stopPairing()}>断开</Button></CardFooter>
    <CardContent><p id="wireless-hint" className="field-hint">{hint}</p></CardContent>
  </Card></div>;
}
function UsbPanel({ client: c }: { client: ClientController }) {
  return <div id="usb-panel" hidden={c.mode !== 'usb'}><Card className="settings-card">
    <CardHeader><CardTitle as="h2">USB 手机</CardTitle><CardDescription>使用数据线连接电脑和手机。</CardDescription><CardAction><Button id="refresh-devices" variant="outline" size="sm" disabled={c.devicesLoading} onClick={() => void c.refreshDevices()}><RefreshCw className="size-3.5" />刷新设备</Button></CardAction></CardHeader>
    <CardContent><div id="device-list" className="usb-list">{c.devices === null ? <p>连接数据线后点击刷新。</p> : !c.devices.length ? <p>未发现手机。请检查数据线、USB 调试和手机上的授权弹窗。</p> : c.devices.map(device => {
      const available = device.state === 'device' && device.usb && !device.emulator;
      return <label key={device.serial} className="usb-option"><input type="radio" name="device" value={device.serial} checked={c.selectedSerial === device.serial && available} disabled={!available || c.busy} onChange={() => c.selectUsb(device)} /><span><strong>{device.model?.replaceAll('_', ' ') || 'Android 手机'}</strong><small>{device.serial} · {device.state === 'unauthorized' ? '请在手机授权 USB 调试' : available ? 'USB 已连接' : device.state}</small></span></label>;
    })}</div><details className="help-details"><summary>ADB 设置</summary><Input id="adb-path" label="ADB 路径（可选）" value={c.draft.adbPath} onChange={value => c.setDraft(previous => ({ ...previous, adbPath: value }))} placeholder="自动查找，或填写完整路径" maxLength={4096} disabled={c.busy} /><p>USB 连接需开启调试授权，并在电脑安装 Android platform-tools。</p></details></CardContent>
    <CardFooter><Button id="save-device" disabled={c.busy || c.saving || !c.ready} onClick={() => void c.save()}>保存设备</Button></CardFooter>
  </Card></div>;
}
function DevicePage({ client: c }: { client: ClientController }) {
  return <section id="page-device" className="settings-page" hidden={c.page !== 'device'}>
    <div className="page-heading"><h1>连接手机</h1><p>选择连接方式，准备开始。</p></div>
    <Tabs variant="underline" value={c.mode} onValueChange={value => { if (!c.busy) c.setMode(value as ConnectionMode); }}><TabsList aria-label="连接方式" className="connection-tabs"><TabsTrigger id="mode-wireless" value="wireless" disabled={c.busy} className="gap-2"><Wifi className="size-3.5" />无线连接</TabsTrigger><TabsTrigger id="mode-usb" value="usb" disabled={c.busy} className="gap-2"><Usb className="size-3.5" />USB 连接</TabsTrigger></TabsList><TabsContent value="wireless"><WirelessPanel client={c} /></TabsContent><TabsContent value="usb"><UsbPanel client={c} /></TabsContent></Tabs>
    <details className="help-details"><summary>连接不上？</summary><p>在手机 TapPilot 中开启无障碍服务和自动化，然后扫码连接。保持手机解锁。</p><p>检查同一 Wi-Fi、所选电脑地址及防火墙。二维码过期后，点击“断开”再重新生成。</p><p>配对仅本次有效，一次连接一台手机。网络中断会停止任务，不会自动补做动作。</p></details>
  </section>;
}
export function App() {
  const c = useClient();
  const { theme, themeError, toggleTheme } = useTheme();
  const pages = [{ value: 'task', label: '任务', icon: Layers2 }, { value: 'model', label: '模型', icon: Bot }, { value: 'device', label: '设备', icon: Smartphone }] as const;
  return <TooltipProvider><div className="app-shell"><div className="window-drag" /><Tabs variant="underline" className="app-layout" value={c.page} onValueChange={value => c.setPage(value as PageName)}>
    <aside className="app-sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">T</span>TapPilot</div>
      <TabsList aria-label="主导航" aria-orientation="vertical" className="sidebar-nav" wrapperClassName="sidebar-nav-wrap">{pages.map(({ value, label, icon: Icon }) => <TabsTrigger key={value} value={value} data-page={value} className="sidebar-tab" indicatorClassName="sidebar-indicator"><Icon className="size-4" />{label}</TabsTrigger>)}</TabsList>
      <div className="sidebar-footer"><Button id="theme-toggle" variant="ghost" size="sm" onClick={toggleTheme} aria-label={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}>{theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}{theme === 'dark' ? '浅色主题' : '深色主题'}</Button>{themeError && <p className="theme-error" role="status">{themeError}</p>}<div><LockKeyhole className="size-3" /><span>任务记录仅在本次保留</span></div><span id="version">v{c.version}</span></div>
    </aside>
    <div className="workspace">
      <header className="workspace-header"><span className="workspace-title">{pages.find(page => page.value === c.page)?.label}</span><div className="workspace-actions"><Button variant="ghost" size="sm" data-goto="device" onClick={() => c.setPage('device')} className="connection-button"><span id="connection-dot" className="connection-dot" data-connected={c.connected} /><span id="connection-label" className="truncate">{c.connected ? `${c.deviceName} · ${c.mode === 'wireless' ? '无线' : 'USB'}` : '连接手机'}</span><ChevronRight className="size-3" /></Button><span className="header-divider" /><Tooltip content="立即停止手机自动化；之后需在手机上恢复。"><Button id="emergency-button" variant="ghost" size="sm" disabled={c.stopping || !c.ready} onClick={() => void c.emergency()}><Square className="size-3" />紧急停止</Button></Tooltip></div></header>
      <main className="app-main"><div id="notice" role="status" className="app-notice" data-error={c.notice.error} hidden={!c.notice.text}>{c.notice.text}</div><TabsContent value="task" className="page-content"><TaskPage client={c} /></TabsContent><TabsContent value="model" className="page-content"><ModelPage client={c} /></TabsContent><TabsContent value="device" className="page-content"><DevicePage client={c} /></TabsContent></main>
    </div>
  </Tabs></div></TooltipProvider>;
}
