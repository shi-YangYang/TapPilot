// Isolated profile; exercises production IPC and UI without a phone or paid API.
const { app, BrowserWindow, session } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { until, createUi } = require('./electron-ui.cjs');
const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-improvement-ui-'));
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
delete process.env.TAPPILOT_SKILL_EMULATOR;
let networkRequests = 0;
let stage = 'startup';
const deadline = setTimeout(() => finish(1), 60_000);
function finish(code) {
  clearTimeout(deadline);
  rmSync(directory, { recursive: true, force: true });
  if (code) process.stderr.write(`IMPROVEMENT_UI_SMOKE_FAILED (${stage})\n`);
  app.exit(code);
}
require('../dist/main.cjs');
void (async () => {
  await app.whenReady();
  // Model requests use a separate Electron session. Reject every attempted
  // request, count it, and assert zero rather than contacting any provider.
  session.fromPartition('tappilot-model-network', { cache: false }).webRequest.onBeforeRequest((_, callback) => {
    networkRequests++; callback({ cancel: true });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const window = BrowserWindow.getAllWindows()[0], ui = createUi(window);
  const invoke = async (method, value) => ui.js(`window.tapPilot.${method}(${value === undefined ? '' : JSON.stringify(value)})`);
  const list = async () => {
    const reply = await invoke('listSkills'); assert.equal(reply.ok, true); return reply.result;
  };
  const screenshots = process.env.TAPPILOT_UI_SCREENSHOTS;
  const capture = name => ui.capture(screenshots && path.join(screenshots, `${name}.png`));
  await until(async () => (await ui.js('window.tapPilot.state()')).result.improvement?.phase === 'idle');
  stage = 'navigation and toggle';
  await ui.page('model');
  assert.equal(await ui.js('document.querySelector("#page-model #improvement-toggle") !== null'), false);
  assert.equal(await ui.js('document.querySelector("#page-model").textContent.includes("填写说明")'), false);
  await ui.page('improvement', true);
  await ui.waitVisible('#improvement-toggle');
  assert.equal(await ui.js('document.querySelector("#improvement-toggle").getAttribute("aria-pressed")'), 'true');
  await ui.click('#improvement-toggle');
  await until(async () => !(await ui.js('window.tapPilot.state()')).result.improvement.enabled);
  await until(() => ui.js('document.querySelector("#improvement-status").textContent === "已关闭"'), 5000, 'Disabled improvement rendered');
  assert.equal((await ui.js('window.tapPilot.setImprovement({enabled:"true"})')).ok, false);
  assert.equal((await ui.js('window.tapPilot.setImprovement({enabled:true, code:"ignored"})')).ok, false);
  assert.equal(await ui.js('/每天|每日.{0,12}(?:2|200)/.test(document.querySelector("#page-improvement").textContent)'), false);
  stage = 'model scope';
  const saved = await invoke('saveConfig', { baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic-skill-management', apiKey: '', adbPath: path.join(directory, 'no-adb'), serial: '', mode: 'usb' });
  assert.equal(saved.ok, true);
  await ui.page('model'); await ui.page('improvement');
  const empty = await list();
  assert.ok(empty.scope); assert.deepEqual(empty.items, []);
  const spec = { schemaVersion: 1, scope: empty.scope,
    trigger: { actionKind: 'tap_element', errorCode: 'NODE_NOT_ACTIONABLE', reason: 'NO_CLICKABLE_TARGET' },
    entryConditions: [],
    program: { entry: 0, nodes: [{ kind: 'step', operation: { op: 'inspect', aspect: 'hierarchy' }, next: 1 }, { kind: 'end', outcome: 'continue' }] },
    lineage: { negativeFeedback: [] }, basis: 'hypothesis', expiresAt: Date.now() + 86_400_000 };

  // UI CRUD assertions follow below. Every fixture is synthetic and remains in
  // this temporary profile; no real failure is enqueued, so evaluation stays idle.
  stage = 'management IPC validation';
  for (const payload of [
    { title: '合成技能', spec, state: 'active' },
    { title: '合成技能', spec, validation: { passed: true } },
    { title: '', spec },
    { title: '合成技能', spec: { ...spec, arbitraryCode: 'synthetic' } },
  ]) assert.equal((await invoke('createSkill', payload)).ok, false);
  assert.deepEqual((await list()).items, []);

  stage = 'UI create';
  await ui.click('#skill-new');
  await ui.type('#skill-title', '合成界面恢复技能');
  await ui.checkLayout('new skill editor');
  await ui.click('#skill-save');
  await ui.waitVisible('#skill-detail');
  await until(async () => (await list()).items.length === 1);
  const created = (await list()).items[0];
  assert.equal(created.title, '合成界面恢复技能');
  assert.equal(created.state, 'draft');
  assert.equal(created.source, 'manual');
  assert.deepEqual(created.spec.scope, empty.scope);
  assert.equal(created.validation, undefined);
  assert.equal((await invoke('state')).result.improvement.enabled, false);
  assert.equal((await invoke('state')).result.improvement.dailyModelCalls, 0);
  assert.match(await ui.js('document.querySelector("#skill-detail").textContent'), /合成界面恢复技能/);
  assert.equal(await ui.js('document.querySelector("#skill-detail .skill-state").dataset.state'), 'draft');

  stage = 'UI search and theme layout';
  await ui.click('#skill-detail-close');
  await ui.type('#skill-search', '不匹配的合成名称');
  await ui.waitVisible('#skill-empty');
  assert.equal(await ui.js('document.querySelectorAll("#skill-list [data-skill-id]").length'), 0);
  await ui.type('#skill-search', '恢复');
  await ui.waitVisible(`[data-skill-id="${created.id}"]`);
  for (const theme of ['dark', 'light']) {
    if (await ui.js('document.documentElement.dataset.theme') !== theme) await ui.click('#theme-toggle');
    await ui.checkLayout(`${theme} skill library`);
    await capture(`improvement-${theme}-library`);
  }
  window.setSize(960, 700);
  await ui.checkLayout('skill library minimum window');
  await ui.click(`[data-skill-id="${created.id}"]`);
  await ui.waitVisible('#skill-detail');
  await ui.checkLayout('skill detail minimum window');
  await capture('improvement-light-detail');

  stage = 'UI edit and SQLite reopen';
  await ui.click('#skill-edit');
  await ui.type('#skill-title', '合成界面恢复技能（已编辑）');
  await ui.click('#skill-step-add');
  await ui.checkLayout('skill editor minimum window');
  await capture('improvement-light-editor');
  await ui.click('#skill-save');
  await ui.waitVisible('#skill-detail');
  await until(async () => (await list()).items[0]?.title === '合成界面恢复技能（已编辑）');
  const edited = (await list()).items[0];
  assert.equal(edited.id, created.id);
  assert.equal(edited.state, 'draft');
  assert.equal(edited.spec.program.nodes.length, created.spec.program.nodes.length + 1);
  assert.equal(edited.spec.program.nodes.at(-2).operation.op, 'verify_effect');
  assert.deepEqual(edited.spec.entryConditions, created.spec.entryConditions);
  assert.deepEqual(edited.spec.scope, created.spec.scope);
  const { SkillStore } = await import(pathToFileURL(path.resolve(__dirname, '../../server/dist/skills/store.js')).href);
  const reopened = new SkillStore(directory);
  assert.deepEqual(await reopened.listManagedSkills(), [edited]);
  assert.deepEqual(await reopened.loadTaskSnapshot(edited.spec.scope), []);
  for (const payload of [
    { id: edited.id, title: edited.title, spec: edited.spec, state: 'active' },
    { id: edited.id, title: edited.title, spec: edited.spec, validation: { passed: true } },
  ]) assert.equal((await invoke('updateSkill', payload)).ok, false);
  assert.equal((await invoke('deleteSkill', { id: edited.id, arbitrary: true })).ok, false);
  assert.equal((await invoke('deleteSkill', { id: '../invalid' })).ok, false);
  assert.deepEqual((await list()).items, [edited]);

  stage = 'UI delete';
  await ui.click('#skill-delete');
  await ui.waitVisible('#skill-delete-confirm');
  await ui.click('#skill-delete-cancel');
  assert.equal((await list()).items.length, 1);
  await ui.click('#skill-delete');
  await ui.click('#skill-delete-confirm');
  await ui.waitVisible('#skill-empty');
  await until(async () => (await list()).items.length === 0);
  assert.deepEqual(await new SkillStore(directory).listManagedSkills(), []);
  assert.equal((await invoke('state')).result.improvement.activeSkills, 0);

  stage = 'branch and prevention preservation';
  const branched = { ...spec,
    entryConditions: [{ fact: 'complete', test: 'eq', value: 'yes' }],
    program: { entry: 0, nodes: [
      { kind: 'branch', condition: { fact: 'hasObservation', test: 'eq', value: true }, yes: 1, no: 3 },
      { kind: 'step', operation: { op: 'inspect', aspect: 'context' }, next: 2 }, { kind: 'end', outcome: 'continue' },
      { kind: 'step', operation: { op: 'observe', mode: 'refresh_if_missing' }, next: 4 }, { kind: 'end', outcome: 'stop' },
    ] },
    prevention: { entryConditions: [{ fact: 'observedLabelChanges', test: 'eq', value: 'yes' }], program: spec.program },
  };
  const seeded = await invoke('createSkill', { title: '合成分支技能', spec: branched });
  assert.equal(seeded.ok, true);
  await ui.type('#skill-search', '');
  await ui.click('#skills-refresh');
  await ui.click(`[data-skill-id="${seeded.result.id}"]`);
  await ui.click('#skill-edit');
  assert.equal(await ui.visible('#skill-step-add'), false);
  await ui.type('#skill-title', '合成分支技能（更名）');
  await ui.click('#skill-save');
  await ui.waitVisible('#skill-detail');
  await until(async () => (await list()).items[0]?.title === '合成分支技能（更名）');
  const renamed = (await list()).items[0];
  assert.deepEqual(renamed.spec, branched, 'Renaming must preserve conditions, branching, prevention, scope, lineage and expiry');
  assert.equal(renamed.state, 'draft');
  await ui.click('#skill-delete'); await ui.click('#skill-delete-confirm');
  await ui.waitVisible('#skill-empty');
  assert.deepEqual(await new SkillStore(directory).listManagedSkills(), []);

  stage = 'rollback and foreground cancellation';
  await ui.click('#improvement-toggle');
  await until(async () => (await ui.js('window.tapPilot.state()')).result.improvement.enabled);
  await ui.checkLayout('automatic improvement');
  assert.equal((await ui.js('window.tapPilot.rollbackImprovement()')).ok, true);
  await ui.page('task');
  assert.equal((await ui.js('window.tapPilot.demo()')).ok, true);
  await until(async () => (await ui.js('window.tapPilot.state()')).result.running);
  assert.equal((await ui.js('window.tapPilot.cancel()')).ok, true);
  await until(async () => !(await ui.js('window.tapPilot.state()')).result.running);
  const stopped = (await ui.js('window.tapPilot.state()')).result.improvement;
  assert.equal(stopped.phase, 'paused');
  assert.equal(stopped.lastReason, 'cancelled');
  assert.equal(stopped.queued, 0);
  assert.equal(stopped.dailyModelCalls, 0);
  assert.equal(networkRequests, 0);
  process.stdout.write('Automatic improvement management smoke passed: isolated profile, menu, UI CRUD/search, SQLite reopen, strict IPC, dark/light layout, toggle, rollback and foreground cancellation. No phone or model request.\n');
  finish(0);
})().catch(error => {
  // All assertions involve synthetic data; keep failure diagnostics useful.
  process.stderr.write(`${error?.message || 'Assertion failed'}\n`); finish(1);
});
