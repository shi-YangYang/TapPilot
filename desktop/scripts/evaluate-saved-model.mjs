// Launch with Electron. The saved key is decrypted only inside the trusted host
// and never copied into argv, environment, reports or the candidate sandbox.
import { app, safeStorage } from 'electron';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { SettingsStore } from '../src/settings.mjs';
import { createModelFetch } from '../src/model-network.mjs';
import { generateScenarios, runScenario, summarize } from '../../server/dist/eval/index.js';
import { persistReport } from '../../server/dist/eval/cli.js';

app.setName('TapPilot');
const args = process.argv.slice(2);
const defaults = ['fresh_ids-1', 'duplicate_labels-1', 'ime_layout-1', 'slow_loading-1', 'lost_response-1', 'session_change-1'];
void app.whenReady().then(async () => { try {
  if (![3, 5].includes(args.length) || args[0] !== '--use-saved-model' || args[1] !== '--output' || args.length === 5 && args[3] !== '--scenarios') throw new Error('USAGE');
  const samples = args[4]?.split(',') ?? defaults;
  if (!samples.length || samples.some(id => !defaults.includes(id)) || new Set(samples).size !== samples.length) throw new Error('USAGE');
  const plannedTasks = samples.length * 3;
  const settings = new SettingsStore(join(homedir(), 'Library', 'Application Support', 'TapPilot'), {
    decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
  });
  await settings.load();
  const model = settings.model();
  const modelFetch = createModelFetch();
  const signal = AbortSignal.timeout(20 * 60_000);
  const results = [];
  const scenarios = generateScenarios().filter(value => samples.includes(value.id));
  for (let repetition = 1; repetition <= 3 && !signal.aborted; repetition++) {
    for (const scenario of scenarios) {
      if (signal.aborted) break;
      const result = await runScenario(scenario, { model, modelFetch, signal });
      results.push({ ...result, repetition });
      const report = { schemaVersion: 1, suiteVersion: scenario.suiteVersion, mode: 'model', split: 'all',
        status: signal.aborted ? 'budget_exhausted' : results.length === plannedTasks ? 'completed' : 'in_progress', plannedTasks, attemptedTasks: results.length,
        repetitions: 3, results, summary: summarize(results) };
      await persistReport(resolve(args[2]), report);
      process.stdout.write(JSON.stringify({ scenario: scenario.id, repetition, verdict: result.verdict,
        falseCompletion: result.falseCompletion, modelRequests: result.metrics.modelRequests }) + '\n');
    }
  }
  process.stdout.write(JSON.stringify({ finished: results.length === plannedTasks, summary: summarize(results) }) + '\n');
  app.exit(results.length !== plannedTasks || results.some(value => value.verdict === 'failed' || value.verdict === 'unknown') ? 1 : 0);
} catch {
  process.stderr.write('SAVED_MODEL_EVAL_FAILED: 请检查本机已保存模型及系统钥匙串；不会输出模型配置。\n');
  app.exit(2);
} });
