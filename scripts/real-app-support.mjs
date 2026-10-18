// Real-app emulator utilities. This lane never relaxes synthetic-fixture isolation.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDeviceLease } from './testbed-batch.mjs';
import { createNativeEntry } from './native-executor-eval.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REAL_APP_PACKAGES = ['com.xunmeng.pinduoduo', 'org.wikipedia', 'de.danoeh.antennapod', 'net.gsantner.markor', 'org.fossify.math', 'org.fossify.filemanager', 'org.schabi.newpipe', 'org.fossify.clock'];
export const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value) ? value : undefined;
export function fail(code) { throw new Error(code); }

/** Exact public UI expectations only. Reports retain IDs and counts, never selector values. */
export function validateRealAppAssertions(assertions) {
  if (!Array.isArray(assertions) || assertions.length < 1 || assertions.length > 20) fail('INVALID_ORACLE_ASSERTIONS');
  const ids = new Set();
  return assertions.map(assertion => {
    if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion) ||
      Object.keys(assertion).some(key => !['id', 'selector', 'minCount', 'maxCount'].includes(key)) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(assertion.id ?? '') || ids.has(assertion.id)) fail('INVALID_ORACLE_ASSERTIONS');
    ids.add(assertion.id);
    const selector = assertion.selector;
    if (!selector || typeof selector !== 'object' || Array.isArray(selector) || !Object.keys(selector).length) fail('INVALID_ORACLE_ASSERTIONS');
    for (const [key, value] of Object.entries(selector)) {
      if (['text', 'resourceId', 'contentDescription', 'className'].includes(key)) {
        if (typeof value !== 'string' || value.length < 1 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_ORACLE_ASSERTIONS');
      } else if (!['checked', 'editable', 'enabled', 'selected', 'scrollable'].includes(key) || typeof value !== 'boolean') fail('INVALID_ORACLE_ASSERTIONS');
    }
    const minCount = assertion.minCount ?? 1;
    const maxCount = assertion.maxCount ?? 1;
    // Absence is explicit (0..0), never the vacuous "zero or one" assertion.
    if (![minCount, maxCount].every(value => Number.isInteger(value) && value >= 0 && value <= 500) ||
      minCount > maxCount || (minCount === 0 && maxCount !== 0)) fail('INVALID_ORACLE_ASSERTIONS');
    return { id: assertion.id, selector: { ...selector }, minCount, maxCount };
  });
}

/** Initial launch readiness only; no mutation or model request is replayed. */
export async function waitForRealAppForeground(client, signal, timeoutMs = 6000, packageName = REAL_APP_PACKAGES[0]) {
  if (!REAL_APP_PACKAGES.includes(packageName) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) fail('INVALID_PREFLIGHT_ARGUMENT');
  const end = Date.now() + timeoutMs;
  do {
    signal.throwIfAborted();
    const current = typeof client.execute === 'function' ? await client.execute('get_current_app', {}, signal) :
      await client.call('get_current_app', {}, signal);
    if (current?.ok === true && current.result?.packageName === packageName) return;
    if (current?.ok !== true && !['NO_ACTIVE_WINDOW', 'STALE_SNAPSHOT', 'PROTECTED_APP'].includes(current?.error?.code)) {
      fail(safeCode(current?.error?.code) ?? 'REAL_APP_PREFLIGHT_FAILED');
    }
    if (Date.now() >= end) break;
    await delay(Math.min(100, Math.max(1, end - Date.now())), undefined, { signal });
  } while (Date.now() < end);
  fail('REAL_APP_NOT_FOREGROUND');
}

export function validateLaunchComponent(component, packageName = REAL_APP_PACKAGES[0]) {
  if (!REAL_APP_PACKAGES.includes(packageName) || typeof component !== 'string' || component.length > 256) fail('INVALID_LAUNCH_COMPONENT');
  const [componentPackage, activity, extra] = component.split('/');
  if (componentPackage !== packageName || extra !== undefined || !/^\.?[A-Za-z][A-Za-z0-9_.]*$/.test(activity ?? '') ||
    !(activity.startsWith('.') || activity.startsWith(`${packageName}.`))) fail('INVALID_LAUNCH_COMPONENT');
  return component;
}

/** Explicit emulator test reset: force-stop and launch only this allowlisted app. */
export async function launchRealApp(session, component, signal = AbortSignal.timeout(15_000)) {
  validateRealAppOptions(session);
  validateLaunchComponent(component, session.packageName);
  signal.throwIfAborted();
  const result = await session.adb('shell', 'am', 'start', '-S', '-W', '-n', component);
  if (/Error:|Exception|Status:\s*timeout/.test(result)) fail('REAL_APP_LAUNCH_FAILED');
  await waitForRealAppForeground(session.client, signal, 6000, session.packageName);
}

export function validateRealAppOptions({ serial, packageName = REAL_APP_PACKAGES[0], query = '机械键盘', entry = 'desktop', decisionDelayMs = 0 }) {
  if (!/^emulator-\d+$/.test(serial ?? '')) fail('ISOLATED_EMULATOR_REQUIRED');
  if (!REAL_APP_PACKAGES.includes(packageName)) fail('REAL_APP_NOT_ALLOWLISTED');
  if (!['desktop', 'mcp'].includes(entry)) fail('INVALID_ENTRY');
  // Only a short public product query is accepted, never credentials or personal identifiers.
  if (typeof query !== 'string' || !/^[\p{L}\p{N} ·-]{1,40}$/u.test(query) || /\d{6,}/.test(query)) fail('PUBLIC_PRODUCT_QUERY_REQUIRED');
  if (!Number.isInteger(decisionDelayMs) || decisionDelayMs < 0 || decisionDelayMs > 15_000) fail('INVALID_DECISION_DELAY');
  return { serial, packageName, query, entry, decisionDelayMs };
}

/** Creates one exclusive emulator session; caller must close it before another lane runs. */
export async function createRealAppSession(options) {
  const config = validateRealAppOptions(options);
  const adbPath = options.adbPath ?? process.env.ADB_PATH ?? path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const adb = async (...command) => (await exec(adbPath, ['-s', config.serial, ...command],
    { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  if (await adb('get-state') !== 'device' || await adb('shell', 'getprop', 'ro.kernel.qemu') !== '1') fail('ISOLATED_EMULATOR_REQUIRED');
  const lease = await acquireDeviceLease({ serial: config.serial, runId: randomUUID() });
  let client, environment;
  try {
    const [packageInfo, apiLevel] = await Promise.all([
      adb('shell', 'dumpsys', 'package', config.packageName), adb('shell', 'getprop', 'ro.build.version.sdk'),
    ]);
    const appVersion = packageInfo.match(/\bversionName=([a-zA-Z0-9._-]{1,64})\b/)?.[1];
    const appVersionCode = packageInfo.match(/\bversionCode=(\d+)\b/)?.[1];
    if (!appVersionCode) fail('REAL_APP_NOT_INSTALLED');
    environment = { apiLevel: /^\d+$/.test(apiLevel) ? Number(apiLevel) : null,
      appVersion: appVersion ?? null, appVersionCode: Number(appVersionCode) };
    if (config.entry === 'desktop') {
      const [{ Adb }, { Bridge }, { createPhoneClient }] = await Promise.all([
        import(pathToFileURL(path.join(root, 'server/dist/adb.js'))),
        import(pathToFileURL(path.join(root, 'server/dist/bridge.js'))),
        import(pathToFileURL(path.join(root, 'server/dist/client-tools.js'))),
      ]);
      const access = new Adb({ executable: adbPath, serial: config.serial, allowEmulator: true });
      await access.select();
      const phone = createPhoneClient(new Bridge(access), access);
      client = { tools: phone.tools, execute: (...args) => phone.execute(...args),
        call: (name, args, signal = AbortSignal.timeout(15_000)) => phone.execute(name, args, signal), close: () => phone.close() };
    } else client = await createNativeEntry(config.entry, { adbPath, serial: config.serial });
  } catch (error) { await lease.release(); throw error; }
  let closed = false;
  return {
    ...config, adb, client, environment,
    /** Independent UIAutomator readback only, run serially after all TapPilot calls finish. */
    async inspect({ query = config.query, stage = 'search_results', assertions, timeoutMs = 2500 } = {}) {
      validateRealAppOptions({ ...config, query });
      if (!['search_input', 'search_results', 'assertions'].includes(stage) || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) fail('INVALID_ORACLE_ARGUMENT');
      if (stage !== 'assertions' && config.packageName !== REAL_APP_PACKAGES[0]) fail('INVALID_ORACLE_ARGUMENT');
      const expectations = stage === 'assertions' ? validateRealAppAssertions(assertions) : undefined;
      const runId = randomUUID();
      const output = await adb('shell', 'am', 'instrument', '-w', '-e', 'class',
        'dev.tappilot.testbed.RealAppObservationInstrumentedTest', '-e', 'realAppObservation', 'true',
        '-e', 'packageName', config.packageName, '-e', 'query', query, '-e', 'stage', stage,
        ...(expectations ? ['-e', 'assertionsBase64', Buffer.from(JSON.stringify(expectations), 'utf8').toString('base64')] : []),
        '-e', 'timeoutMs', String(timeoutMs), '-e', 'runId', runId,
        'dev.tappilot.testbed.test/androidx.test.runner.AndroidJUnitRunner');
      if (/FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/.test(output)) fail('REAL_APP_ORACLE_FAILED');
      const value = JSON.parse(await adb('exec-out', 'run-as', 'dev.tappilot.testbed', 'cat', 'files/real-app-observation.json'));
      if (value.schemaVersion !== 1 || value.runId !== runId || value.packageName !== config.packageName || value.stage !== stage) fail('ORACLE_RESULT_MISMATCH');
      return value;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await client.close(); } finally { await lease.release(); }
    },
  };
}
