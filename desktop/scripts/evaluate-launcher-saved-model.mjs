// Use the saved desktop model inside Electron; credentials never enter argv or reports.
import { app, safeStorage } from 'electron';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { SettingsStore } from '../src/settings.mjs';
import { createModelFetch } from '../src/model-network.mjs';
import { parseLauncherArguments, createLauncherSession, runLauncherEvaluation, launcherErrorCode } from '../../scripts/launcher-navigation-eval.mjs';

app.setName('TapPilot');
void app.whenReady().then(async () => {
  let session, exitCode = 2;
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort(new Error('CANCELLED'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const args = parseLauncherArguments(process.argv.slice(2), true);
    if (!args.output) throw new Error('OUTPUT_REQUIRED');
    const settings = new SettingsStore(join(homedir(), 'Library', 'Application Support', 'TapPilot'), {
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    });
    await settings.load();
    session = await createLauncherSession(args);
    const report = await runLauncherEvaluation({ session, model: settings.model(), modelFetch: createModelFetch(),
      timeoutMs: args.timeoutMs, signal: cancelled.signal, onProgress: step => process.stdout.write(`${JSON.stringify(step)}\n`) });
    await mkdir(dirname(resolve(args.output)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    exitCode = report.passed ? 0 : 1;
  } catch (error) { process.stderr.write(`${launcherErrorCode(error?.code ?? error?.message)}\n`); }
  finally {
    await session?.close().catch(() => {});
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    app.exit(exitCode);
  }
});
