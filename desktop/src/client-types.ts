import type { SkillScope, SkillSpec, SkillOperation } from '../../server/src/skills/schema.js';
import type { SkillValidation } from '../../server/src/skills/evaluation.js';
export type { SkillScope, SkillSpec, SkillOperation };
export type ConnectionMode = 'wireless' | 'usb';
export type PageName = 'task' | 'model' | 'device' | 'improvement';
export interface ManagedSkill {
  id: string;
  title: string;
  state: 'draft' | 'candidate' | 'active' | 'superseded' | 'revoked' | 'rejected';
  source: 'manual' | 'automatic';
  spec: SkillSpec;
  createdAt: number;
  updatedAt: number;
  successes: number;
  failures: number;
  validation?: SkillValidation;
}
export interface SkillInput { title: string; spec: SkillSpec }
export interface PublicConfig {
  baseUrl: string;
  model: string;
  vision: boolean;
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
  completionReads?: number;
  preflightReads?: number;
}
export interface ImprovementStatus {
  enabled: boolean;
  phase: 'idle' | 'queued' | 'generating' | 'evaluating' | 'adopted' | 'rejected' | 'paused' | 'budget_exhausted' | 'error';
  activeSkills: number;
  queued: number;
  dailyJobs: number;
  dailyModelCalls: number;
  lastReason?: string;
  lastFailure?: { stage: 'generation' | 'evaluation' | 'adoption' | 'lifecycle'; code: string; httpStatus?: number };
}
export interface ClientEvent {
  navigationSteps?: number;
  navigationStopReason?: string;
  type: string;
  demo?: boolean;
  turn?: number;
  toolName?: string;
  action?: string;
  ok?: boolean;
  errorCode?: string;
  errorReason?: string;
  observationChanged?: boolean;
  durationMs?: number;
  status?: 'completed' | 'cancelled' | 'failed';
  answer?: string;
  error?: { code?: string; message: string };
  metrics?: Metrics;
  state?: WirelessState;
  improvement?: ImprovementStatus;
}
export type ConnectionInput = { mode: 'wireless'; deviceId: string } | { mode: 'usb'; serial: string };
export type Reply<T> = { ok: true; result: T } | { ok: false; error: { code?: string; message: string } };
export interface TapPilotApi {
  state(): Promise<Reply<{ config: PublicConfig; running: boolean; version: string; startupError?: string; wireless: WirelessState; improvement?: ImprovementStatus }>>;
  saveConfig(value: ConfigInput): Promise<Reply<PublicConfig>>;
  testModel(): Promise<Reply<{ model: string; durationMs: number }>>;
  setImprovement(value: { enabled: boolean }): Promise<Reply<ImprovementStatus>>;
  rollbackImprovement(): Promise<Reply<ImprovementStatus>>;
  listSkills(): Promise<Reply<{ items: ManagedSkill[]; scope?: SkillScope }>>;
  createSkill(value: SkillInput): Promise<Reply<ManagedSkill>>;
  updateSkill(value: SkillInput & { id: string }): Promise<Reply<ManagedSkill>>;
  deleteSkill(value: { id: string }): Promise<Reply<{ deleted: true }>>;
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
