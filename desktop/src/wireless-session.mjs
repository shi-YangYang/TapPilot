import { ClientError, object } from './settings.mjs';

const idle = () => ({ connected: false, paired: false, closed: true, host: '', port: 0, pairingExpiresAt: 0, pairingAvailable: false });

/** Owns pairing state in memory. Phone RPC sessions never receive the URI or QR code. */
export class WirelessSession {
  constructor({ startHub, addresses, qr, onState }) { this.startHub = startHub; this.addresses = addresses; this.qr = qr; this.onState = onState; this.hub = undefined; this.generation = 0; this.starting = false; }
  status() { return this.hub?.status() ?? idle(); }
  interfaces() { return this.addresses().map(({ address, name }) => ({ address, name })); }
  async start(value) {
    object(value, ['host']);
    if (typeof value.host !== 'string' || !this.interfaces().some(item => item.address === value.host)) throw new ClientError('INVALID_LAN_ADDRESS', '请选择本机当前可用的局域网地址。');
    if (this.starting || this.hub && !this.hub.status().closed) throw new ClientError('PAIRING_ACTIVE', '已有无线会话，请先断开后重新配对。');
    const generation = ++this.generation;
    this.starting = true;
    let created;
    try {
      created = await this.startHub({ host: value.host, port: 0, onState: state => { if (generation === this.generation) this.onState(state); } });
      if (generation !== this.generation) throw new ClientError('PAIRING_CANCELLED', '无线配对已取消。');
      this.hub = created;
      const pairingUri = created.pairingUri;
      const qrDataUrl = await this.qr(pairingUri);
      if (generation !== this.generation) throw new ClientError('PAIRING_CANCELLED', '无线配对已取消。');
      return { status: this.status(), pairingUri, qrDataUrl };
    } catch (error) {
      await created?.close();
      if (this.hub === created) this.hub = undefined;
      throw error;
    } finally { this.starting = false; }
  }
  pairingUri() {
    if (!this.hub?.status().pairingAvailable) throw new ClientError('PAIRING_EXPIRED', '配对二维码已使用或过期，请断开并重新配对。');
    return this.hub.pairingUri;
  }
  forDevice(deviceId) {
    const state = this.status();
    if (!state.connected || state.closed || !state.deviceId || state.deviceId !== deviceId) throw new ClientError('WIRELESS_DISCONNECTED', '所选无线手机尚未连接，请重新连接或配对后再开始任务。');
    return this.hub;
  }
  async close() {
    ++this.generation;
    const hub = this.hub; this.hub = undefined;
    await hub?.close();
    this.onState(idle());
  }
}
