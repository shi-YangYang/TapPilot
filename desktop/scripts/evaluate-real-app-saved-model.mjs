// Launch with Electron; decrypt only in the trusted host. Never put credentials,
// endpoint, screen text, screenshots or model replies into output or argv.
import { app, safeStorage } from 'electron';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { SettingsStore } from '../src/settings.mjs';
import { createModelFetch } from '../src/model-network.mjs';
import { createRealAppSession, launchRealApp } from '../../scripts/real-app-support.mjs';
import { parseRealAppModelArguments, runRealAppModel } from '../../scripts/real-app-model.mjs';

app.setName('TapPilot');
void app.whenReady().then(async () => {
  let session;
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort(new Error('CANCELLED'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let exitCode = 2;
  try {
    const args = parseRealAppModelArguments(process.argv.slice(2));
    if (args.help) {
      process.stdout.write('desktop/node_modules/.bin/electron desktop/scripts/evaluate-real-app-saved-model.mjs --use-saved-model --serial emulator-5580 --output /tmp/real-app-model.json [--case CASE_ID] [--query 文具] [--launch-component PACKAGE/ACTIVITY] [--timeout-ms 180000]\nSelects only a fixed case from scripts/real-app-cases.mjs (default: pdd-search; --query is accepted only for that case). Launch component defaults to the selected case. Requires authorized TapPilot and read-only testbed observer APKs on a dedicated emulator. Uses the saved desktop model without changing settings.\n');
      exitCode = 0;
    } else {
      session = await createRealAppSession({ serial: args.serial, entry: 'desktop', packageName: args.packageName, query: args.query });
      await launchRealApp(session, args.launchComponent, cancelled.signal);
      const settings = new SettingsStore(join(homedir(), 'Library', 'Application Support', 'TapPilot'), {
        decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
      });
      await settings.load();
      const report = await runRealAppModel({ session, model: settings.model(), modelFetch: createModelFetch(),
        caseId: args.caseId, query: args.query, timeoutMs: args.timeoutMs, signal: cancelled.signal,
        onProgress: step => process.stdout.write(`${JSON.stringify(step)}\n`) });
      await mkdir(dirname(resolve(args.output)), { recursive: true, mode: 0o700 });
      await writeFile(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ status: report.status, modelRequests: report.modelRequests, completionVerified: report.completionVerified, ...(report.errorCode ? { errorCode: report.errorCode } : {}) })}\n`);
      exitCode = report.status === 'success' ? 0 : 1;
    }
  } catch (error) {
    const code = error?.code ?? error?.message;
    process.stderr.write(`${typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(code) ? code : 'SAVED_REAL_APP_MODEL_FAILED'}\n`);
  } finally {
    await session?.close().catch(() => {});
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    app.exit(exitCode);
  }
});
