// Run with: node test/run-electron-smoke.cjs electron-theme-smoke.cjs
// Theme-only integration check: temporary profile, synthetic drafts, no phone/model.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { until, createUi } = require('./electron-ui.cjs');
const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-theme-smoke-'));
const packageInfo = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
require('../dist/main.cjs');

(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const window = BrowserWindow.getAllWindows()[0];
  const ui = createUi(window);
  const { js } = ui;
  const screenshots = process.env.TAPPILOT_UI_SCREENSHOTS;
  const themeState = () => js(`({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    background: getComputedStyle(document.body).backgroundColor,
    foreground: getComputedStyle(document.body).color,
    label: document.getElementById('theme-toggle')?.getAttribute('aria-label')
  })`);
  const checkTheme = async theme => {
    await until(async () => (await themeState()).theme === theme, 5000, `${theme} theme`);
    assert.deepEqual(await themeState(), theme === 'dark'
      ? { theme, dark: true, background: 'rgb(16, 16, 16)', foreground: 'rgb(244, 244, 244)', label: '切换为浅色主题' }
      : { theme, dark: false, background: 'rgb(255, 255, 255)', foreground: 'rgb(27, 27, 27)', label: '切换为深色主题' });
  };
  const selectTheme = async theme => {
    if ((await themeState()).theme !== theme) await ui.click('#theme-toggle');
    await checkTheme(theme);
  };
  const checkPreferenceOnly = async theme => {
    const stored = await js('Object.fromEntries(Object.entries(localStorage))');
    assert.deepEqual(stored, { 'tappilot.theme': theme }, 'Only a non-sensitive theme preference is persisted by these interactions');
  };
  const ready = async () => {
    await ui.waitVisible('#theme-toggle');
    await until(() => js('!document.getElementById("demo-button")?.disabled'));
    assert.equal((await js('window.tapPilot.state()')).result.version, packageInfo.version);
  };
  await ready();
  await checkTheme('dark');

  // Render both palettes through real controls; never start pairing or capture a QR.
  for (const theme of ['dark', 'light']) {
    await selectTheme(theme);
    window.setSize(1190, 820);
    for (const page of ['task', 'model', 'device']) {
      await ui.page(page);
      if (page === 'device') await ui.click('#mode-wireless');
      await ui.checkLayout(`${theme} ${page}`);
    }
    window.setSize(960, 700);
    for (const page of ['task', 'model', 'device']) {
      await ui.page(page);
      await ui.checkLayout(`${theme} ${page} narrow`);
      if (screenshots) await ui.capture(path.join(screenshots, `${theme}-${page}.png`));
    }
  }

  const taskDraft = '合成主题测试：读取当前界面。';
  const modelDraft = { baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-unsaved-model', apiKey: 'synthetic-unsaved-theme-key' };
  await ui.page('task');
  await ui.type('#task-input', taskDraft);
  await ui.page('model');
  await ui.type('#base-url', modelDraft.baseUrl);
  await ui.type('#model-name', modelDraft.model);
  await ui.type('#api-key', modelDraft.apiKey);
  await selectTheme('dark');
  assert.equal(await ui.visible('#page-model'), true, 'Theme switch keeps the current page');
  const readModelDraft = () => js(`({ baseUrl: document.getElementById('base-url').value, model: document.getElementById('model-name').value, apiKey: document.getElementById('api-key').value })`);
  assert.deepEqual(await readModelDraft(), modelDraft, 'Theme switch preserves unsaved model input');
  await checkPreferenceOnly('dark');

  // Desktop pairing input exists only after generating credentials, so exercise
  // the ordinary USB settings draft without opening any phone connection.
  await ui.page('device');
  await ui.click('#mode-usb');
  await ui.click('#usb-panel details > summary');
  const deviceDraft = '/synthetic/unsaved/adb';
  await ui.type('#adb-path', deviceDraft);
  await selectTheme('light');
  assert.equal(await ui.visible('#page-device'), true);
  assert.equal(await ui.visible('#usb-panel'), true, 'Theme switch preserves the connection tab');
  assert.equal(await js('document.getElementById("adb-path").value'), deviceDraft);
  await ui.page('model');
  assert.deepEqual(await readModelDraft(), modelDraft);
  await ui.page('task');
  assert.equal(await js('document.getElementById("task-input").value'), taskDraft);
  await checkPreferenceOnly('light');

  // A theme change must not recreate the client or interrupt the in-flight task.
  await ui.click('#demo-button');
  await until(() => js('document.getElementById("run-badge")?.textContent === "演示中"'));
  await selectTheme('dark');
  assert.equal(await ui.visible('#page-task'), true);
  await until(() => js('document.getElementById("run-badge")?.textContent === "演示完成"'));
  assert.match(await js('document.getElementById("answer").textContent'), /合成界面/);
  assert.equal(await js('document.getElementById("task-input").value'), taskDraft);
  await selectTheme('light');
  await checkPreferenceOnly('light');

  const loaded = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await loaded;
  await ready();
  await checkTheme('light');
  await checkPreferenceOnly('light');
  assert.equal(await js('document.getElementById("task-input").value'), '', 'Task draft is not persisted with the theme');
  await ui.page('model');
  assert.equal(await js('document.getElementById("api-key").value'), '', 'Secret draft is not persisted with the theme');
  assert.equal((await js('window.tapPilot.state()')).result.config.hasKey, false);
  assert.notEqual(await js('document.getElementById("model-name").value'), modelDraft.model);

  rmSync(directory, { recursive: true, force: true });
  process.stdout.write(`Electron theme smoke passed (${packageInfo.version}): real dark/light toggle, exact palettes, page and unsaved drafts retained, active synthetic task completes, only theme preference persisted and restored on reload, both themes across three pages at default/minimum size. No phone, pairing or model request.\n`);
  app.exit(0);
})().catch(error => {
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
  process.stderr.write(`${error.message}\n`);
  app.exit(1);
});
