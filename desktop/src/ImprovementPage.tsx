import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronRight, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select';
import type { ManagedSkill, SkillOperation, SkillSpec } from './client-types';
import type { ClientController } from './use-client';
import { improvementStatusText } from './improvement-copy';
import {
  actionLabels, aspectLabels, capabilityLabels, defaultOperation, displaySkillTitle, errorLabels, evidenceLabels, isLinearProgram, newSkillSpec,
  observeLabels, operationLabels, operationText, predicateText, reasonLabels, skillStateLabels, triggerText,
} from './skill-management-copy';

function Choice({ label, value, labels, onChange, disabled }: { label: string; value: string; labels: Record<string, string>; onChange: (value: string) => void; disabled?: boolean }) {
  const options = value in labels ? labels : { ...labels, [value]: value };
  return <div className="skill-choice" role="group" aria-label={label}><span>{label}</span><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(options).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></div>;
}
function OperationFields({ operation, onChange }: { operation: SkillOperation; onChange: (value: SkillOperation) => void }) {
  switch (operation.op) {
    case 'observe': return <Choice label="读取方式" value={operation.mode} labels={observeLabels} onChange={mode => onChange({ ...operation, mode: mode as typeof operation.mode })} />;
    case 'wait': return <Choice label="最多等待" value={String(operation.timeoutMs)} labels={{ 250: '0.25 秒', 500: '0.5 秒', 1000: '1 秒' }} onChange={value => onChange({ ...operation, timeoutMs: Number(value) as typeof operation.timeoutMs })} />;
    case 'resolve_target': return <><Choice label="目标类型" value={operation.capability} labels={capabilityLabels} onChange={value => onChange({ ...operation, capability: value as typeof operation.capability })} /><Choice label="检查上层控件" value={String(operation.maxAncestorHops)} labels={{ 0: '仅当前控件', 1: '向上 1 层', 2: '向上 2 层', 3: '向上 3 层' }} onChange={value => onChange({ ...operation, maxAncestorHops: Number(value) })} /></>;
    case 'inspect': return <Choice label="检查内容" value={operation.aspect} labels={aspectLabels} onChange={value => onChange({ ...operation, aspect: value as typeof operation.aspect })} />;
    case 'scroll_resolved_container': return <Choice label="滚动方向" value={operation.direction} labels={{ forward: '向前一次', backward: '向后一次' }} onChange={value => onChange({ ...operation, direction: value as typeof operation.direction })} />;
    case 'verify_effect': return <Choice label="验证依据" value={operation.evidence} labels={evidenceLabels} onChange={value => onChange({ ...operation, evidence: value as typeof operation.evidence })} />;
    default: return null;
  }
}
function Conditions({ conditions }: { conditions: SkillSpec['entryConditions'] }) {
  return conditions.length ? <div className="skill-conditions">{conditions.map((condition, index) => <span key={index}>{predicateText(condition)}</span>)}</div> : <p className="field-hint">无额外条件</p>;
}
function ProgramView({ program }: { program: SkillSpec['program'] }) {
  return <ol className="skill-program">{program.nodes.map((node, index) => <li key={index}><span className="skill-step-number">{index + 1}</span><div>{node.kind === 'step' ? <>{operationText(node.operation)}{node.next !== index + 1 && <small>继续第 {node.next + 1} 步</small>}</> : node.kind === 'branch' ? <>判断：{predicateText(node.condition)}<small>符合 → 第 {node.yes + 1} 步；不符合 → 第 {node.no + 1} 步</small></> : node.outcome === 'continue' ? '继续当前任务' : '停止本次恢复'}</div></li>)}</ol>;
}
function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return <div className="skill-detail-section"><h3>{label}</h3>{children}</div>;
}
function SkillDetail({ item, locked, onClose, onEdit, onDelete }: { item: ManagedSkill; locked: boolean; onClose: () => void; onEdit: () => void; onDelete: () => Promise<boolean> }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return <article id="skill-detail" className="skill-detail">
    <div className="skill-panel-heading"><Button id="skill-detail-close" variant="ghost" size="sm" onClick={onClose}><ArrowLeft className="size-3.5" />技能库</Button><div className="skill-row-actions"><Button id="skill-edit" variant="outline" size="sm" disabled={locked} onClick={onEdit}><Pencil className="size-3.5" />编辑</Button><Button id="skill-delete" variant="ghost" size="icon" aria-label="删除技能" disabled={locked} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /></Button></div></div>
    <div className="skill-detail-title"><span className="skill-state" data-state={item.state}>{skillStateLabels[item.state]}</span><h2>{displaySkillTitle(item)}</h2><p>{item.source === 'manual' ? '手动添加' : '自动总结'} · 更新于 {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</p></div>
    {confirmDelete && <div id="skill-delete-confirmation" className="skill-delete-confirm" role="alert"><p>删除“{displaySkillTitle(item)}”？此操作无法撤销。</p><div><Button id="skill-delete-cancel" variant="ghost" size="sm" disabled={locked} onClick={() => setConfirmDelete(false)}>取消</Button><Button id="skill-delete-confirm" size="sm" disabled={locked} onClick={() => void onDelete()}>确认删除</Button></div></div>}
    <DetailSection label="适用场景"><p>{triggerText(item.spec.trigger)}</p><p className="field-hint">{reasonLabels[item.spec.trigger.reason] || item.spec.trigger.reason}</p><Conditions conditions={item.spec.entryConditions} /></DetailSection>
    <DetailSection label="执行步骤"><ProgramView program={item.spec.program} /></DetailSection>
    {item.spec.prevention && <DetailSection label="提前预防"><Conditions conditions={item.spec.prevention.entryConditions} /><ProgramView program={item.spec.prevention.program} /></DetailSection>}
    <dl className="skill-detail-stats"><div><dt>成功使用</dt><dd>{item.successes} 次</dd></div><div><dt>失败记录</dt><dd>{item.failures} 次</dd></div><div><dt>有效期至</dt><dd>{new Date(item.spec.expiresAt).toLocaleDateString('zh-CN')}</dd></div></dl>
    <details className="help-details skill-advanced"><summary>查看完整方案</summary><pre>{JSON.stringify(item.spec, null, 2)}</pre></details>
  </article>;
}
function SkillEditor({ initial, locked, onCancel, onSave }: { initial: { id?: string; title: string; spec: SkillSpec }; locked: boolean; onCancel: () => void; onSave: (value: { title: string; spec: SkillSpec }) => Promise<boolean> }) {
  const [title, setTitle] = useState(initial.title);
  const [spec, setSpec] = useState<SkillSpec>(() => structuredClone(initial.spec));
  const [raw, setRaw] = useState(() => JSON.stringify(initial.spec, null, 2));
  const [rawEdited, setRawEdited] = useState(false);
  const [error, setError] = useState('');
  const setNextSpec = (next: SkillSpec) => { setSpec(next); setRaw(JSON.stringify(next, null, 2)); setError(''); };
  const updateOperation = (index: number, operation: SkillOperation) => setNextSpec({ ...spec, program: { ...spec.program, nodes: spec.program.nodes.map((node, position) => position === index && node.kind === 'step' ? { ...node, operation } : node) } });
  const removeStep = (index: number) => setNextSpec({ ...spec, program: { ...spec.program, nodes: spec.program.nodes.filter((_, position) => position !== index).map((node, position) => node.kind === 'step' ? { ...node, next: position + 1 } : node) } });
  const addStep = () => setNextSpec({ ...spec, program: { ...spec.program, nodes: [...spec.program.nodes.slice(0, -1), { kind: 'step', operation: defaultOperation('verify_effect'), next: spec.program.nodes.length }, spec.program.nodes.at(-1)!] } });
  const submit = async () => {
    if (!title.trim()) { setError('请填写技能名称。'); return; }
    let value = spec;
    if (rawEdited) {
      try { value = JSON.parse(raw) as SkillSpec; } catch { setError('完整方案的 JSON 格式有误，请检查后重试。'); return; }
    }
    setError('');
    if (!await onSave({ title: title.trim(), spec: value })) setError('未能保存，请检查上方提示。内容已保留。');
  };
  const linear = isLinearProgram(spec.program);
  return <form id="skill-editor" className="skill-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="skill-panel-heading"><h2>{initial.id ? '编辑技能' : '新增技能'}</h2><Button id="skill-editor-close" variant="ghost" size="icon" aria-label="取消编辑" disabled={locked} onClick={onCancel}><X className="size-4" /></Button></div>
    <p className="skill-editor-caption">{initial.id ? '修改内容需重新验证，通过后生效。' : '验证通过后生效。'}</p>
    <Input id="skill-title" label="技能名称" value={title} onChange={setTitle} placeholder="例如：页面刷新后重新定位" maxLength={80} disabled={locked} required />
    <fieldset disabled={locked || rawEdited} className="skill-form-fields">
      <div className="skill-trigger-fields"><Choice label="操作" value={spec.trigger.actionKind} labels={actionLabels} onChange={value => setNextSpec({ ...spec, trigger: { ...spec.trigger, actionKind: value as SkillSpec['trigger']['actionKind'] } })} /><Choice label="遇到问题" value={spec.trigger.errorCode} labels={errorLabels} onChange={value => setNextSpec({ ...spec, trigger: { ...spec.trigger, errorCode: value as SkillSpec['trigger']['errorCode'] } })} /><Choice label="具体原因" value={spec.trigger.reason} labels={reasonLabels} onChange={value => setNextSpec({ ...spec, trigger: { ...spec.trigger, reason: value as SkillSpec['trigger']['reason'] } })} /></div>
      <DetailSection label="执行步骤">{linear ? <>
        <div className="skill-step-editor">{spec.program.nodes.map((node, index) => node.kind !== 'step' ? null : <div className="skill-step-edit" key={index}><span className="skill-step-number">{index + 1}</span><div><Choice label={`第 ${index + 1} 步`} value={node.operation.op} labels={operationLabels} onChange={value => updateOperation(index, defaultOperation(value as SkillOperation['op']))} /><div className="skill-step-parameters"><OperationFields operation={node.operation} onChange={operation => updateOperation(index, operation)} /></div></div><Button variant="ghost" size="icon" aria-label={`删除第 ${index + 1} 步`} disabled={spec.program.nodes.length <= 2} onClick={() => removeStep(index)}><X className="size-3.5" /></Button></div>)}</div>
        <Button id="skill-step-add" variant="ghost" size="sm" disabled={spec.program.nodes.length >= 8} onClick={addStep}><Plus className="size-3.5" />添加步骤</Button>
        <Choice label="步骤结束后" value={(spec.program.nodes.at(-1) as Extract<SkillSpec['program']['nodes'][number], { kind: 'end' }>).outcome} labels={{ continue: '继续当前任务', stop: '停止本次恢复' }} onChange={value => setNextSpec({ ...spec, program: { ...spec.program, nodes: [...spec.program.nodes.slice(0, -1), { kind: 'end', outcome: value as 'continue' | 'stop' }] } })} />
      </> : <><ProgramView program={spec.program} /><p className="field-hint">包含判断分支，可在下方“编辑完整方案”中修改。</p></>}</DetailSection>
      <DetailSection label="生效条件"><Conditions conditions={spec.entryConditions} /></DetailSection>
      {spec.prevention && <DetailSection label="提前预防"><Conditions conditions={spec.prevention.entryConditions} /><ProgramView program={spec.prevention.program} /></DetailSection>}
    </fieldset>
    <details className="help-details skill-advanced"><summary>编辑完整方案</summary><p>包含条件、分支与适用范围。修改后保留完整方案并重新验证。</p><textarea id="skill-spec-json" aria-label="完整技能方案 JSON" value={raw} onChange={event => { setRaw(event.target.value); setRawEdited(true); setError(''); }} disabled={locked} spellCheck={false} maxLength={32768} />{rawEdited && <Button id="skill-reset-json" variant="ghost" size="sm" disabled={locked} onClick={() => { setRaw(JSON.stringify(spec, null, 2)); setRawEdited(false); setError(''); }}>恢复表单内容</Button>}</details>
    {error && <p id="skill-editor-error" className="skill-form-error" role="alert">{error}</p>}
    <div className="skill-editor-footer"><Button id="skill-cancel" variant="ghost" disabled={locked} onClick={onCancel}>取消</Button><Button id="skill-save" type="submit" disabled={locked}>{locked ? '保存中…' : '保存技能'}</Button></div>
  </form>;
}
export function ImprovementPage({ client: c }: { client: ClientController }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string>();
  const [editor, setEditor] = useState<{ id?: string; title: string; spec: SkillSpec }>();
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const locked = !c.ready || c.skillsBusy || c.busy;
  const items = c.skillItems.filter(item => (filter === 'all' || item.state === filter || filter === 'pending' && ['draft', 'candidate'].includes(item.state)) && `${displaySkillTitle(item)} ${triggerText(item.spec.trigger)} ${skillStateLabels[item.state]}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedItem = c.skillItems.find(item => item.id === selected);
  return <section id="page-improvement" className="improvement-page" hidden={c.page !== 'improvement'}>
    <div className="page-heading"><h1>自动改进</h1><p>从失败中积累经验，让后续任务更稳。</p></div>
    <div className="improvement-overview"><div className="improvement-overview-icon"><Sparkles className="size-5" /></div><div className="improvement-overview-content"><h2>持续学习</h2><p id="improvement-status" role="status">{improvementStatusText(c.improvement)}</p></div><Button id="improvement-toggle" variant={c.improvement.enabled ? 'primary' : 'outline'} aria-pressed={c.improvement.enabled} disabled={!c.ready || c.improvementBusy || c.skillsBusy} onClick={() => void c.toggleImprovement()}>{c.improvement.enabled && <Check className="size-3.5" />}{c.improvement.enabled ? '已开启' : '开启'}</Button></div>
    <div className="improvement-meta"><span>{c.improvement.activeSkills} 项有效技能<span className="improvement-meta-dot">·</span>使用当前模型，可能产生费用</span><Button id="improvement-rollback" variant="ghost" size="sm" disabled={!c.improvement.activeSkills || c.improvementBusy || c.skillsBusy || c.busy} onClick={() => setRollbackConfirm(true)}>撤回改进</Button></div>
    {rollbackConfirm && <div className="skill-delete-confirm" role="alert"><p>撤回已生效的自动改进？技能记录会保留。</p><div><Button variant="ghost" size="sm" disabled={c.improvementBusy || c.skillsBusy} onClick={() => setRollbackConfirm(false)}>取消</Button><Button id="improvement-rollback-confirm" size="sm" disabled={c.improvementBusy || c.skillsBusy || c.busy} onClick={() => { void c.rollbackImprovement(); setRollbackConfirm(false); }}>确认撤回</Button></div></div>}
    <div className="skills-section-heading"><div><h2>技能库</h2><span>{c.skillItems.length} 项技能</span></div><div><Button id="skills-refresh" variant="ghost" size="icon" aria-label="刷新技能" disabled={c.skillsLoading || c.skillsBusy || !c.ready} onClick={() => void c.refreshSkills()}><RefreshCw className={`size-3.5${c.skillsLoading ? ' animate-spin' : ''}`} /></Button><Button id="skill-new" variant="outline" size="sm" disabled={locked || !c.skillScope || !!editor} onClick={() => { if (c.skillScope) { setSelected(undefined); setEditor({ title: '', spec: newSkillSpec(c.skillScope) }); } }}><Plus className="size-3.5" />新增技能</Button></div></div>
    {!c.skillScope && <p className="field-hint">配置并保存模型后，即可添加技能。</p>}
    {editor ? <SkillEditor key={editor.id || 'new'} initial={editor} locked={locked} onCancel={() => setEditor(undefined)} onSave={async value => { const saved = editor.id ? await c.updateSkill(editor.id, value) : await c.createSkill(value); if (!saved) return false; setEditor(undefined); setSelected(saved.id); return true; }} /> : selectedItem ? <SkillDetail key={selectedItem.id} item={selectedItem} locked={locked} onClose={() => setSelected(undefined)} onEdit={() => setEditor({ id: selectedItem.id, title: displaySkillTitle(selectedItem), spec: selectedItem.spec })} onDelete={async () => { const deleted = await c.deleteSkill(selectedItem.id); if (deleted) setSelected(undefined); return deleted; }} /> : <>
      <div className="skills-toolbar"><Input id="skill-search" aria-label="搜索技能" value={search} onChange={setSearch} placeholder="搜索技能" leftIcon={<Search className="size-3.5" />} /><Choice label="筛选状态" value={filter} labels={{ all: '全部状态', active: '已生效', pending: '待验证', rejected: '未通过', revoked: '已撤回', superseded: '已替换' }} onChange={setFilter} /></div>
      <div id="skill-list" className="skill-list" aria-busy={c.skillsLoading}>{!items.length ? <div id="skill-empty" className="skill-empty"><Sparkles className="size-5" /><h3>{c.skillsLoading ? '正在读取技能…' : search || filter !== 'all' ? '没有匹配的技能' : '还没有技能'}</h3><p>{search || filter !== 'all' ? '试试其他关键词或状态。' : '任务遇到问题后会自动总结，也可以手动添加。'}</p></div> : items.map(item => <button key={item.id} className="skill-list-row" data-skill-id={item.id} onClick={() => setSelected(item.id)}><span className="skill-list-icon">{item.state === 'active' ? <Check className="size-4" /> : <Sparkles className="size-4" />}</span><span className="skill-list-content"><strong>{displaySkillTitle(item)}</strong><span>{triggerText(item.spec.trigger)}</span></span><span className="skill-state" data-state={item.state}>{skillStateLabels[item.state]}</span><ChevronRight className="size-3.5" /></button>)}</div>
    </>}
  </section>;
}
