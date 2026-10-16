import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, validateConfig, taskInput, assertSender } from '../src/settings.mjs';
import { runDemo } from '../src/demo.mjs';

const valid = { baseUrl: 'https://example.test/v1', model: 'tool-capable-model', apiKey: 'synthetic-test-key', serial: 'TEST123' };
test('configuration rejects credential-bearing, remote plaintext, and injected fields', () => {
  for (const baseUrl of ['http://remote.test/v1', 'https://key:secret@example.test/v1', 'file:///etc/passwd', 'https://example.test/?apiKey=secret']) assert.throws(() => validateConfig({ ...valid, baseUrl }));
  assert.throws(() => validateConfig({ ...valid, exec: 'shell' }));
  assert.throws(() => validateConfig({ ...valid, adbPath: 'relative/adb' }));
  assert.equal(validateConfig({ ...valid, baseUrl: 'http://127.0.0.1:8080/v1' }).baseUrl, 'http://127.0.0.1:8080/v1');
});
test('output budget defaults to 8192 and accepts only bounded safe integers', () => {
  assert.equal(validateConfig(valid).maxOutputTokens, 8192);
  for (const maxOutputTokens of [256, 4096, 32768]) {
    assert.equal(validateConfig({ ...valid, maxOutputTokens }).maxOutputTokens, maxOutputTokens);
  }
  for (const maxOutputTokens of [null, '8192', 255, 32769, 8192.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateConfig({ ...valid, maxOutputTokens }), error => error.code === 'INVALID_OUTPUT_LIMIT');
  }
});
test('output budget survives save and reload while legacy v1 settings use the default', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tappilot-output-budget-'));
  const cipher = { encrypt: async value => Buffer.from([...value].reverse().join('')), decrypt: async value => [...value.toString()].reverse().join('') };
  try {
    const store = new SettingsStore(directory, cipher);
    assert.equal((await store.load()).maxOutputTokens, 8192);
    assert.equal((await store.save({ ...valid, maxOutputTokens: 4096 })).maxOutputTokens, 4096);
    const restored = new SettingsStore(directory, cipher);
    assert.equal((await restored.load()).maxOutputTokens, 4096);
    assert.equal(restored.model().maxOutputTokens, 4096);
    const legacy = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(legacy.version, 1);
    assert.equal(legacy.maxOutputTokens, 4096);
    delete legacy.maxOutputTokens;
    await writeFile(store.file, JSON.stringify(legacy));
    const legacyStore = new SettingsStore(directory, cipher);
    assert.equal((await legacyStore.load()).maxOutputTokens, 8192);
    assert.equal(legacyStore.model().maxOutputTokens, 8192);
    assert.equal(legacyStore.model().apiKey, valid.apiKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('secret is encrypted on disk, never returned, retained or explicitly cleared', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tappilot-settings-'));
  const cipher = { encrypt: async value => Buffer.from([...value].reverse().join('')), decrypt: async value => [...value.toString()].reverse().join('') };
  try {
    const store = new SettingsStore(directory, cipher);
    const result = await store.save(valid);
    assert.equal(result.hasKey, true);
    assert.equal('apiKey' in result, false);
    assert.equal((await readFile(store.file, 'utf8')).includes(valid.apiKey), false);
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    const restored = new SettingsStore(directory, cipher); await restored.load();
    assert.equal(restored.model().apiKey, valid.apiKey);
    await restored.save({ ...valid, apiKey: '' }); assert.equal(restored.model().apiKey, valid.apiKey);
    await restored.save({ ...valid, apiKey: '', clearKey: true }); assert.equal(restored.public().hasKey, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('switching provider origin cannot carry the previous secret', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tappilot-provider-'));
  try {
    const store = new SettingsStore(directory, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() });
    await store.save(valid);
    await store.save({ ...valid, apiKey: '', baseUrl: 'https://example.test/alternate/v1' });
    assert.equal(store.model().apiKey, valid.apiKey);
    await store.save({ ...valid, apiKey: '', baseUrl: 'https://another-provider.test/v1' });
    assert.equal(store.model().apiKey, '');
    assert.equal(store.public().hasKey, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('encryption failure cannot silently persist plaintext', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tappilot-encryption-'));
  try {
    const store = new SettingsStore(directory, { encrypt: async () => { throw new Error('unavailable'); } });
    await assert.rejects(store.save(valid));
    await assert.rejects(readFile(store.file));
    assert.equal(store.public().hasKey, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('task and IPC authority are pinned to exact main frame', () => {
  assert.throws(() => taskInput({ task: 'read', serial: '' }));
  assert.throws(() => taskInput({ task: 'read', serial: 'TEST', options: {} }));
  const mainFrame = { url: 'file:///app/index.html' };
  const window = { webContents: { mainFrame } };
  assertSender({ sender: window.webContents, senderFrame: mainFrame }, window, mainFrame.url);
  assert.throws(() => assertSender({ sender: {}, senderFrame: mainFrame }, window, mainFrame.url));
  assert.throws(() => assertSender({ sender: window.webContents, senderFrame: { ...mainFrame } }, window, mainFrame.url));
});
test('demo cancellation ends promptly without external work', async () => {
  const controller = new AbortController();
  const events = [];
  const pending = runDemo(controller.signal, event => { events.push(event); controller.abort(); });
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.metrics.toolCalls, 0); assert.equal(events.length, 1);
});
