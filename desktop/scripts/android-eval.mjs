// Headless Electron host for Android evaluation using the user's saved desktop model.
// This reads the profile once. It never launches production main, UI or background improvement.
import { app, safeStorage, session } from 'electron';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsStore } from '../src/settings.mjs';
import { createModelFetch } from '../src/model-network.mjs';

const knownErrors = new Set([
  'INVALID_ARGUMENT', 'INVALID_INPUT', 'INVALID_ENDPOINT', 'INVALID_MODEL', 'INVALID_ADB_PATH', 'INVALID_SERIAL',
  'MODEL_CONFIG_REQUIRED', 'MODEL_CONFIG_MISSING', 'SETTINGS_UNREADABLE', 'KEYCHAIN_UNAVAILABLE', 'PROFILE_READ_ONLY',
  'EXPLICIT_TEST_DEVICE_REQUIRED', 'UNKNOWN_FIXTURE', 'INVALID_SEED', 'SERVICE_NOT_READY', 'FIXTURE_RESET_FAILED',
  'FIXTURE_WINDOW_NOT_READY', 'FIXTURE_APP_LEFT', 'DEVICE_LEASE_BUSY', 'DEVICE_LEASE_INVALID', 'DEVICE_LEASE_NOT_OWNER',
  'DEVICE_LEASE_RECOVERY_BUSY', 'INVALID_DEVICE_LEASE', 'INVALID_BATCH_IDENTITY', 'INVALID_BATCH_BUDGET',
  'BATCH_JOURNAL_EXISTS', 'BATCH_JOURNAL_MISSING', 'BATCH_JOURNAL_INVALID', 'BATCH_JOURNAL_TOO_LARGE',
  'BATCH_IDENTITY_MISMATCH', 'BATCH_JOURNAL_CLOSED', 'BATCH_CASE_LIMIT', 'BATCH_REQUEST_LIMIT',
  'BATCH_DURATION_LIMIT', 'BATCH_ABORTED', 'INVALID_CASE_ID', 'DUPLICATE_CASE_REPORT', 'INVALID_CASE_REPORT',
  'BATCH_CHECKPOINT_FAILED', 'INVALID_BUDGET_CHECKPOINT', 'BUDGET_CHECKPOINT_REGRESSION',
  'UNSAFE_CASE_REPORT', 'CASE_REPORT_TOO_LARGE', 'ANDROID_EVAL_FAILED',
]);
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function argumentsOf(argv) {
  let profile, checkModel = false, learning = false;
  const forwarded = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--profile') {
      if (profile !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENT');
      profile = resolve(argv[++index]);
    } else if (argv[index] === '--check-model') {
      if (checkModel) fail('INVALID_ARGUMENT');
      checkModel = true;
    } else if (argv[index] === '--learning-rehearsal') {
      if (learning) fail('INVALID_ARGUMENT');
      learning = true;
    } else forwarded.push(argv[index]);
  }
  if (checkModel && (forwarded.length || learning)) fail('INVALID_ARGUMENT');
  if (!checkModel && !learning) {
    const modeIndex = forwarded.indexOf('--mode');
    if (modeIndex !== -1 && forwarded[modeIndex + 1] !== 'model') fail('INVALID_ARGUMENT');
    if (modeIndex === -1) forwarded.push('--mode', 'model');
  }
  return { profile, checkModel, learning, forwarded };
}

let defaultProfile, temporaryUserData;
function prepareHost() {
  app.setName('TapPilot');
  // Compute the real read-only profile independently; all Electron writes go to this temporary host.
  defaultProfile = join(app.getPath('appData'), 'TapPilot');
  temporaryUserData = mkdtempSync(join(tmpdir(), 'tappilot-android-eval-'));
  const temporarySessionData = join(temporaryUserData, 'session');
  mkdirSync(temporarySessionData, { mode: 0o700 });
  app.setPath('userData', temporaryUserData);
  app.setPath('sessionData', temporarySessionData);
}
const cleanup = () => { try { if (temporaryUserData) rmSync(temporaryUserData, { recursive: true, force: true }); } catch { /* No profile paths or OS messages are logged. */ } };
process.once('exit', cleanup);

let store, model, network;
const controller = new AbortController();
const cancel = () => controller.abort(new Error('BATCH_ABORTED'));
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);

async function run() {
  const args = argumentsOf(process.argv.slice(2));
  await app.whenReady();
  const profile = args.profile ?? defaultProfile;
  try { await access(join(profile, 'settings.json')); }
  catch { fail('MODEL_CONFIG_MISSING'); }
  store = new SettingsStore(profile, {
    encrypt: async () => fail('PROFILE_READ_ONLY'),
    decrypt: async value => {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') fail('KEYCHAIN_UNAVAILABLE');
      return (await safeStorage.decryptStringAsync(value)).result;
    },
  });
  await store.load();
  model = store.model();
  if (args.checkModel) {
    // Configuration readiness is not evidence of network or provider availability.
    process.stdout.write('MODEL_CONFIG_READY\n');
    return;
  }
  network = session.fromPartition(`tappilot-android-eval-${randomUUID()}`, { cache: false });
  const modelFetch = createModelFetch(network);
  const { main } = args.learning ? await import('../../scripts/skill-learning-rehearsal.mjs') : await import('../../scripts/testbed-eval.mjs');
  await main(args.forwarded, { model, modelFetch, signal: controller.signal });
}

async function start() {
  let exitCode = 0;
  try {
    prepareHost();
    await run();
    exitCode = process.exitCode ?? 0;
  } catch (error) {
    const candidate = error?.code ?? error?.message;
    process.stderr.write(`${knownErrors.has(candidate) ? candidate : 'ANDROID_EVAL_FAILED'}\n`);
    exitCode = controller.signal.aborted ? 130 : 2;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    // Best effort to drop live references; plaintext never leaves this process through storage or argv.
    if (model) model.apiKey = '';
    if (store) store.current.apiKey = '';
    if (network) await network.closeAllConnections().catch(() => {});
    cleanup();
    app.exit(exitCode);
  }
}
// Electron waits for entry-module evaluation before emitting ready. Do not await ready at top level.
void start();
