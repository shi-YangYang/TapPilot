export type ConnectionMode = 'wireless' | 'usb';
export type PageName = 'task' | 'model' | 'device';
export interface PublicConfig {
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  hasKey: boolean;
  adbPath: string;
  serial: string;
  mode: ConnectionMode;
}
export interface ConfigInput extends Omit<PublicConfig, 'hasKey'> { apiKey: string; clearKey: boolean }
export interface WirelessState {
  connected: boolean;
  paired?: boolean;
  closed: boolean;
  host?: string;
  port?: number;
  pairingExpiresAt?: number;
  pairingAvailable: boolean;
  deviceId?: string;
  deviceName?: string;
}
export interface UsbDevice { serial: string; state: string; usb: boolean; emulator: boolean; model?: string }
export interface LanAddress { address: string; name: string }
export interface PairingResult { status: WirelessState; pairingUri: string; qrDataUrl: string }
export interface Metrics {
  totalMs: number;
  modelMs: number;
  toolMs: number;
  modelRequests: number;
  toolCalls: number;
  modelRequestBytes?: number;
  modelUiBytes?: number;
  rawUiBytes?: number;
  hostReads?: number;
  preflightReads?: number;
}
export interface ClientEvent {
  type: string;
  demo?: boolean;
  turn?: number;
  toolName?: string;
  action?: string;
  ok?: boolean;
  errorCode?: string;
  observationChanged?: boolean;
  durationMs?: number;
  status?: 'completed' | 'cancelled' | 'failed';
  answer?: string;
  error?: { code?: string; message: string };
  metrics?: Metrics;
  state?: WirelessState;
}
export type ConnectionInput = { mode: 'wireless'; deviceId: string } | { mode: 'usb'; serial: string };
export type Reply<T> = { ok: true; result: T } | { ok: false; error: { code?: string; message: string } };
export interface TapPilotApi {
  state(): Promise<Reply<{ config: PublicConfig; running: boolean; version: string; startupError?: string; wireless: WirelessState }>>;
  saveConfig(value: ConfigInput): Promise<Reply<PublicConfig>>;
  testModel(): Promise<Reply<{ model: string; durationMs: number }>>;
  devices(): Promise<Reply<UsbDevice[]>>;
  wirelessInterfaces(): Promise<Reply<LanAddress[]>>;
  wirelessStart(value: { host: string }): Promise<Reply<PairingResult>>;
  wirelessClose(): Promise<Reply<{ closed: boolean }>>;
  wirelessCopy(): Promise<Reply<{ copied: boolean }>>;
  run(value: ConnectionInput & { task: string }): Promise<Reply<{ started: boolean; demo: boolean }>>;
  demo(): Promise<Reply<{ started: boolean; demo: boolean }>>;
  cancel(): Promise<Reply<{ cancelled: boolean }>>;
  emergencyStop(value: ConnectionInput): Promise<Reply<{ phoneStopped: boolean; demo?: boolean }>>;
  onEvent(listener: (event: ClientEvent) => void): () => void;
}
declare global { interface Window { tapPilot: TapPilotApi } }
