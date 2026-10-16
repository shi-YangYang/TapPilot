// Helpers for own-window Electron smoke tests. Inputs go through Chromium and React.
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

async function until(predicate, timeout = 15000, label = 'UI state') {
  const began = Date.now();
  while (Date.now() - began < timeout) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label} deadline`);
}

function createUi(window) {
  // sendInputEvent requires an OS-focused BrowserWindow. CDP dispatches native
  // Chromium input to this test window even while another app owns macOS focus.
  const debuggerApi = window.webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
  const inputReady = debuggerApi.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const js = async source => { await inputReady; return window.webContents.executeJavaScript(source, true); };
  const visible = selector => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert]'));
  })()`);
  const waitVisible = selector => until(() => visible(selector), 15000, `Visible ${selector}`);
  const click = async selector => {
    await waitVisible(selector);
    await until(() => js(`!document.querySelector(${JSON.stringify(selector)}).disabled`), 15000, `Enabled ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const key = async keyCode => {
    await inputReady;
    const virtualKey = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27 }[keyCode];
    assert.ok(virtualKey, 'Supported own-window key');
    const event = { key: keyCode, code: keyCode, windowsVirtualKeyCode: virtualKey };
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(keyCode === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    await js('new Promise(resolve => requestAnimationFrame(resolve))');
  };
  const focus = async selector => {
    await waitVisible(selector);
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  };
  const type = async (selector, value) => {
    await focus(selector);
    await js(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await key('Backspace');
    if (value) await debuggerApi.sendCommand('Input.insertText', { text: value });
    await until(() => js(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`), 5000, `Input ${selector}`);
  };
  const page = async (name, keyboard = false) => {
    const selector = `[data-page="${name}"]`;
    if (keyboard) { await focus(selector); await key('Enter'); }
    else await click(selector);
    try { await waitVisible(`#page-${name}`); }
    catch {
      const focusState = await js(`({ focused: document.hasFocus(), active: document.activeElement?.getAttribute('data-page') || document.activeElement?.tagName, selected: [...document.querySelectorAll('[data-page][aria-selected=true]')].map(item => item.getAttribute('data-page')) })`);
      throw new Error(`Navigation ${name} failed: ${JSON.stringify(focusState)}`);
    }
    await until(() => js(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') === 'true'`), 5000, `Selected ${name} tab`);
  };
  const settle = async () => {
    await js(`(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Motion uses requestAnimationFrame springs as well as Web Animations.
      await new Promise(resolve => setTimeout(resolve, 400));
      const animations = document.getAnimations().filter(item => item.effect?.getTiming().iterations !== Infinity);
      await Promise.race([Promise.all(animations.map(item => item.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 800))]);
    })()`);
  };
  const capture = async filename => {
    if (!filename) return;
    await settle();
    const secretPresent = await js(`Boolean(document.getElementById('pairing-qr') || document.getElementById('pairing-link')?.value?.includes('token='))`);
    assert.equal(secretPresent, false, 'Never persist a live pairing credential or QR in a screenshot');
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, (await window.webContents.capturePage()).toPNG());
  };
  const checkLayout = async name => {
    await settle();
    const layout = await js(`(() => {
      const controls = [...document.querySelectorAll('button, input:not([type=checkbox]):not([type=radio]), textarea, select')].filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden' && !item.closest('[inert]'));
      const label = item => item.id || item.getAttribute('aria-label') || item.textContent.trim().slice(0, 50);
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        small: controls.filter(item => item.getBoundingClientRect().height < 24).map(label),
        clipped: controls.filter(item => { const box = item.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }).map(label) };
    })()`);
    assert.equal(layout.overflow, false, `${name}: horizontal overflow`);
    assert.deepEqual(layout.small, [], `${name}: controls below 24px`);
    assert.deepEqual(layout.clipped, [], `${name}: clipped controls`);
  };
  return { js, visible, waitVisible, click, focus, key, type, page, settle, capture, checkLayout };
}

module.exports = { until, createUi };
