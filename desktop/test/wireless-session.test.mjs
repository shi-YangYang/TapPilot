import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WirelessSession } from '../src/wireless-session.mjs';
import { taskInput, validateConfig } from '../src/settings.mjs';

function fixture(overrides = {}) {
  let starts = 0; let closes = 0;
  const state = { connected: false, paired: false, closed: false, pairingAvailable: true, pairingExpiresAt: Date.now() + 300_000, host: '192.168.1.8', port: 12345 };
  const hub = { pairingUri: 'tappilot://pair?token=synthetic', status: () => ({ ...state }), close: async () => { closes++; state.closed = true; state.pairingAvailable = false; } };
  const observed = [];
  const session = new WirelessSession({ startHub: async () => { starts++; return hub; }, addresses: () => [{ address: '192.168.1.8', name: 'en0' }], qr: async () => 'data:image/png;base64,synthetic', onState: value => observed.push(value), ...overrides });
  return { session, hub, state, observed, starts: () => starts, closes: () => closes };
}

test('pairing starts only after an exact current interface is selected', async () => {
  const f = fixture();
  assert.equal(f.starts(), 0); assert.equal(f.session.status().closed, true);
  await assert.rejects(f.session.start({ host: '0.0.0.0' }), { code: 'INVALID_LAN_ADDRESS' });
  await assert.rejects(f.session.start({ host: '127.0.0.1' }), { code: 'INVALID_LAN_ADDRESS' });
  await assert.rejects(f.session.start({ host: '192.168.1.8', token: 'injected' }), { code: 'INVALID_INPUT' });
  const result = await f.session.start({ host: '192.168.1.8' });
  assert.equal(result.pairingUri, f.hub.pairingUri); assert.equal(f.starts(), 1);
  assert.equal(JSON.stringify(f.session.status()).includes('token'), false);
  await assert.rejects(f.session.start({ host: '192.168.1.8' }), { code: 'PAIRING_ACTIVE' });
  await f.session.close(); assert.equal(f.closes(), 1); assert.equal(f.session.status().closed, true);
});
test('wireless task requires the exact paired connected identity, and used QR cannot be copied', async () => {
  const f = fixture(); await f.session.start({ host: '192.168.1.8' });
  assert.throws(() => f.session.forDevice('phone-1'), { code: 'WIRELESS_DISCONNECTED' });
  Object.assign(f.state, { connected: true, paired: true, pairingAvailable: false, deviceId: 'phone-1' });
  assert.equal(f.session.forDevice('phone-1'), f.hub);
  assert.throws(() => f.session.forDevice('phone-2'), { code: 'WIRELESS_DISCONNECTED' });
  assert.throws(() => f.session.pairingUri(), { code: 'PAIRING_EXPIRED' });
  f.state.connected = false; assert.throws(() => f.session.forDevice('phone-1'), { code: 'WIRELESS_DISCONNECTED' });
  await f.session.close();
});
test('closing during asynchronous pairing cannot leave a listener alive', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ startHub: () => pending });
  const started = f.session.start({ host: '192.168.1.8' });
  await f.session.close(); release(f.hub);
  await assert.rejects(started, { code: 'PAIRING_CANCELLED' });
  assert.equal(f.closes(), 1); assert.equal(f.session.status().closed, true);
});
test('QR generation failure closes the partially created session', async () => {
  const f = fixture({ qr: async () => { throw new Error('synthetic QR failure'); } });
  await assert.rejects(f.session.start({ host: '192.168.1.8' }), /QR failure/);
  assert.equal(f.closes(), 1); assert.equal(f.session.status().closed, true);
});
test('USB and wireless identity schemas cannot be mixed or expanded', () => {
  assert.deepEqual(taskInput({ task: 'read', mode: 'wireless', deviceId: 'fixture-phone' }), { task: 'read', mode: 'wireless', deviceId: 'fixture-phone' });
  assert.throws(() => taskInput({ task: 'read', mode: 'wireless', deviceId: 'fixture-phone', serial: 'USB123' }));
  assert.throws(() => taskInput({ task: 'read', mode: 'usb', serial: 'USB123', deviceId: 'fixture-phone' }));
  assert.throws(() => taskInput({ task: 'read', mode: 'wireless', deviceId: '../bad' }));
  assert.throws(() => validateConfig({ baseUrl: 'https://example.test/v1', model: 'test', mode: 'wireless', pairingUri: 'tappilot://pair?token=secret' }));
});
