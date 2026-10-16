#!/usr/bin/env node
// Cross-language integration: production Android OkHttp/pinned TLS/WSS -> Node WirelessHub -> PhoneClient.
// The Android instrumentation executor is synthetic. This does NOT claim a real accessibility/UI acceptance test.
// Only an explicitly named Android emulator is allowed. No permissions or device settings are changed.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const runner = 'dev.tappilot.agent.test/androidx.test.runner.AndroidJUnitRunner';
const testMethod = 'dev.tappilot.agent.WirelessIntegrationTest#connectsToDesktopHub';

function options(argv) {
  const result = { serial: 'emulator-5580', host: undefined, emulatorHostAlias: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--serial') result.serial = argv[++i] ?? '';
    else if (argv[i] === '--host') result.host = argv[++i] ?? '';
    else if (argv[i] === '--emulator-host-alias') result.emulatorHostAlias = true;
    else throw new Error('Unsupported option');
  }
  if (!/^emulator-[0-9]{4,5}$/.test(result.serial)) throw new Error('Only emulator serials are allowed');
  if (result.emulatorHostAlias && result.host) throw new Error('Choose LAN host or emulator alias, not both');
  return result;
}

function bounded(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Deadline exceeded')), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// adb shell has a remote shell even though execFile bypasses the local shell. Quote every remote argument.
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

function launchInstrumentation(adb, serial, pairingUri) {
  const args = ['am', 'instrument', '-w', '-r', '-e', 'class', testMethod, '-e', 'pairingUri', pairingUri, runner];
  let finished = false;
  let child;
  const done = new Promise(resolve => {
    child = execFile(adb, ['-s', serial, 'shell', args.map(shellQuote).join(' ')], {
      timeout: 55_000, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => {
      finished = true;
      // Instrumentation output may include its input arguments on a failure. Inspect only; never print it,
      // the execFile Error (which contains the command), or pairingUri to a console/file/model.
      resolve({ passed: !error && /OK \(1 test\)/.test(stdout) && !/FAILURES!!!|INSTRUMENTATION_FAILED|shortMsg=/.test(stdout) });
    });
  });
  return { done, stop: () => { if (!finished) child.kill('SIGTERM'); } };
}

async function main() {
  const started = performance.now();
  let phase = 'validate emulator target';
  let failure;
  let hub;
  let client;
  let instrumentation;
  let calls = 0;
  try {
    const config = options(process.argv.slice(2));
    const adb = process.env.ADB_PATH || path.join(process.env.ANDROID_HOME || path.join(homedir(), 'Library/Android/sdk'), 'platform-tools/adb');
    const adbOptions = { timeout: 8_000, maxBuffer: 16 * 1024, encoding: 'utf8' };
    const state = await exec(adb, ['-s', config.serial, 'get-state'], adbOptions);
    const qemu = await exec(adb, ['-s', config.serial, 'shell', 'getprop', 'ro.kernel.qemu'], adbOptions);
    if (state.stdout.trim() !== 'device' || qemu.stdout.trim() !== '1') throw new Error('Target is not a running emulator');
    const installed = await exec(adb, ['-s', config.serial, 'shell', 'pm', 'list', 'instrumentation'], adbOptions);
    if (!installed.stdout.includes(runner)) throw new Error('Install the current app and androidTest APK first');

    phase = 'start pinned TLS wireless host';
    const { WirelessHub, listLANAddresses } = await import(pathToFileURL(path.join(root, 'server/dist/wireless.js')).href);
    const { createWirelessClient } = await import(pathToFileURL(path.join(root, 'server/dist/client-tools.js')).href);
    const host = config.emulatorHostAlias ? '127.0.0.1' : config.host || listLANAddresses()[0]?.address;
    if (!host) throw new Error('No LAN IPv4 interface; explicitly use --emulator-host-alias for emulator-only testing');
    let connected;
    const connection = new Promise(resolve => { connected = resolve; });
    hub = await WirelessHub.start({ host, onState: state => { if (state.connected) connected(); } });
    let pairingUri = hub.pairingUri;
    if (config.emulatorHostAlias) {
      // 10.0.2.2 is the emulator's explicit route to the host loopback interface. The production
      // Android trust manager still checks the exact DER certificate pin and validity before hello.
      // This changes routing only; it does not disable certificate verification or trust all certificates.
      const uri = new URL(pairingUri);
      uri.searchParams.set('host', '10.0.2.2');
      pairingUri = uri.toString();
    }

    phase = 'Android pinned TLS and WSS handshake';
    instrumentation = launchInstrumentation(adb, config.serial, pairingUri);
    await bounded(Promise.race([connection, instrumentation.done.then(() => { throw new Error('Instrumentation ended before connection'); })]), 20_000);
    if (!hub.status().connected) throw new Error('Android did not pair');
    client = createWirelessClient(hub);
    const signal = new AbortController().signal;
    const execute = async (name, args = {}) => {
      calls++;
      const response = await client.execute(name, args, signal);
      if (response.ok !== true || !response.result || typeof response.result !== 'object') throw new Error('Fixture RPC failed');
      return response.result;
    };

    phase = 'Android synthetic read/action/read through desktop PhoneClient';
    const before = await execute('get_ui_tree');
    const matches = before.nodes?.filter(node => node.text === '无线测试入口' && node.clickable === true && node.enabled === true);
    if (matches?.length !== 1 || typeof before.snapshotId !== 'string') throw new Error('Initial fixture observation did not match');
    const action = await execute('act_and_observe', {
      action: 'click_element', arguments: { snapshotId: before.snapshotId, nodeId: matches[0].nodeId }, waitMs: 0,
    });
    if (!action.observation || action.observationError || action.observation.snapshotId === before.snapshotId) throw new Error('Action did not produce a fresh fixture observation');
    const after = await execute('get_ui_tree');
    if (!after.nodes?.some(node => node.text === '无线测试结果') || after.snapshotId === before.snapshotId || calls !== 3) throw new Error('Final fixture state did not match');
  } catch { failure = phase; }
  finally {
    try { await client?.close(); } catch { failure ??= 'close task bridge'; }
    try { await hub?.close(); } catch { failure ??= 'close wireless host'; }
    if (instrumentation) {
      try {
        const result = await bounded(instrumentation.done, 8_000);
        if (!result.passed) failure ??= 'Android instrumentation assertions';
      } catch {
        failure ??= 'finish Android instrumentation';
        instrumentation.stop(); // Only the adb process started by this script; never force-stop a phone/app.
        await bounded(instrumentation.done, 2_000).catch(() => {});
      }
    }
  }
  const durationMs = Math.round(performance.now() - started);
  if (failure) {
    console.error(`FAIL wireless integration: ${failure}; durationMs=${durationMs}; toolCalls=${calls}. No credentials or instrumentation output logged.`);
    process.exitCode = 1;
  } else {
    console.log(`PASS Android production TLS/WSS + desktop PhoneClient (synthetic UI executor); durationMs=${durationMs}; toolCalls=${calls}`);
  }
}

await main();
