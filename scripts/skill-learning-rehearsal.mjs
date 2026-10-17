// Developer rehearsal with the saved desktop model, an isolated AVD and private
// temporary skill ledger. Never modifies the user's production learning store.
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureAndroidSkillFailure, verifyAdoptedAndroidSkills } from '../server/dist/skills/android-evaluation.js';
import { ContinuousImprover, SkillStore } from '../server/dist/skills/index.js';
import { safeSkillFailure } from '../server/dist/skills/failure.js';
import { skillHash } from '../server/dist/skills/schema.js';
import { SkillUsageTracker } from '../server/dist/skills/usage-outcome.js';
import { episodeFingerprint } from '../server/dist/skills/trace.js';
import { followupEvidence, rehearsalMetrics, summarizeAndroidCaseEvent } from './skill-learning-report.mjs';
import { readPriorEpisodeReport } from './skill-learning-episode.mjs';

// Only this rehearsal's private, schema-validated ledger is read. Candidate
// failures and evaluation receipts remain inspectable even if a later step fails.
export async function candidateEvidence(store) {
  return store.exportCandidates();
}

export async function main(argv, { model, modelFetch, signal }) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--serial', '--output', '--episode-report'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) throw new Error('INVALID_ARGUMENT');
    args[argv[i]] = argv[i + 1];
  }
  if (!/^emulator-\d+$/.test(args['--serial'] ?? '') || !args['--output']) throw new Error('INVALID_ARGUMENT');
  if (args['--episode-report'] && resolve(args['--episode-report']) === resolve(args['--output'])) throw new Error('INVALID_ARGUMENT');
  const root = await mkdtemp(join(tmpdir(), 'tappilot-learning-rehearsal-'));
  const android = { serial: args['--serial'], adbPath: process.env.ADB_PATH ?? join(homedir(), 'Library/Android/sdk/platform-tools/adb') };
  const hostVersion = JSON.parse(await readFile(new URL('../server/package.json', import.meta.url), 'utf8')).version;
  let stage = 'evaluation', store, improver, episode;
  const metrics = rehearsalMetrics();
  const report = { schemaVersion: 2, source: 'real_android_synthetic_fixture', productionStoreModified: false,
    captureSource: args['--episode-report'] ? 'prior_report' : 'current_run', captureCalls: 0,
    completed: false, checks: { failureCaptured: false, candidateGenerated: false, evaluationPassed: false,
      adoptedPersisted: false, laterTaskUsedAdoptedSkill: false, laterTaskSucceeded: false, skillRetainedAfterUsage: false }, androidCases: [] };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(18 * 60_000)]);
  const fetch = async (url, init) => {
    bounded.throwIfAborted();
    if (metrics.calls >= 180) throw new Error('SKILLS_BUDGET_EXHAUSTED');
    metrics.request();
    return modelFetch(url, { ...init, signal: AbortSignal.any([bounded, ...(init.signal ? [init.signal] : [])]) });
  };
  const onCase = value => {
    try {
      const summary = summarizeAndroidCaseEvent(value);
      if (report.androidCases.length >= 64) throw new Error('SKILLS_ANDROID_BUDGET');
      report.androidCases.push(summary);
      process.stdout.write(JSON.stringify({ phase: 'android_case', ...summary, providerCalls: metrics.calls }) + '\n');
    } catch (error) { report.evidenceFailure = safeSkillFailure(error, 'evaluation'); }
  };
  const refreshEvidence = async () => {
    if (!store) return;
    const history = await store.history();
    report.jobs = history.jobs; report.skills = history.skills;
    report.candidates = await candidateEvidence(store);
    report.status = improver ? await improver.status() : await store.status();
    report.checks.candidateGenerated = report.candidates.length > 0;
    report.checks.evaluationPassed = report.candidates.some(candidate => candidate.validation?.contract === 'android_recovery');
  };
  try {
    metrics.transition('capture');
    if (args['--episode-report']) {
      const imported = await readPriorEpisodeReport(args['--episode-report'], { model, hostVersion, signal: bounded });
      episode = imported.episode;
      report.sourceReportHash = imported.sourceReportHash;
      report.episodeFingerprint = imported.episodeFingerprint;
    } else {
      try { episode = await captureAndroidSkillFailure({ android, model, modelFetch: fetch, signal: bounded, hostVersion, onCase }); }
      finally { report.captureCalls = metrics.calls; }
      report.episodeFingerprint = episodeFingerprint(episode);
    }
    report.episode = episode; report.trigger = episode.trigger;
    report.checks.failureCaptured = episode.steps.some(step => step.executor === 'node-v1' && step.contextChange
      && step.errorCode !== 'NONE' && step.dispatchState === 'not_sent');
    process.stdout.write(JSON.stringify({ phase: 'captured', captureSource: report.captureSource, captureCalls: report.captureCalls,
      sourceReportHash: report.sourceReportHash, episodeFingerprint: report.episodeFingerprint,
      trigger: episode.trigger, nativeEvidence: episode.steps.some(s => s.executor === 'node-v1' && s.contextChange) }) + '\n');
    if (!report.checks.failureCaptured) throw new Error('SKILLS_ANDROID_UNREPRODUCIBLE');
    store = new SkillStore(root);
    await store.recordEpisode(episode);
    improver = new ContinuousImprover({ store, android, modelFetch: fetch, resolveModel: () => model,
      onAndroidCase: onCase,
      onInvalidProposal: diagnostic => {
        // Generated by the proposal parser's fixed-field diagnostic sanitizer;
        // never record the rejected response or arbitrary field names/values.
        report.proposalDiagnostics ??= [];
        if (report.proposalDiagnostics.length < 4) report.proposalDiagnostics.push(diagnostic);
        process.stdout.write(JSON.stringify({ phase: 'invalid_proposal', diagnostic }) + '\n');
      },
      onStatus: state => {
        metrics.transition(state.phase);
        if (['generating', 'evaluating', 'adopted'].includes(state.phase))
          stage = state.phase === 'generating' ? 'generation' : state.phase === 'evaluating' ? 'evaluation' : 'adoption';
        process.stdout.write(JSON.stringify({ phase: state.phase, modelCalls: state.dailyModelCalls,
          providerCalls: metrics.calls, activeSkills: state.activeSkills, lastFailure: state.lastFailure }) + '\n');
      } });
    const cancel = () => { void improver.cancel(); };
    bounded.addEventListener('abort', cancel, { once: true });
    try { improver.schedule(); await improver.waitForIdle(); } finally { bounded.removeEventListener('abort', cancel); }
    await refreshEvidence();
    stage = 'adoption'; metrics.transition('reload');
    // Use a new store instance, not the improver's live objects or the candidate
    // passed to evaluation. This checks what the next normal task actually loads.
    store = new SkillStore(root);
    const adopted = await store.loadSnapshot(episode.scope);
    report.adoptedPrograms = adopted;
    const adoptedHashes = adopted.map(skillHash);
    report.checks.adoptedPersisted = adoptedHashes.length > 0 && adoptedHashes.every(hash => report.candidates.some(candidate =>
      candidate.hash === hash && candidate.state === 'active' && candidate.validation?.contract === 'android_recovery'));
    if (!report.checks.adoptedPersisted) {
      report.failure = report.status?.lastFailure ?? safeSkillFailure(new Error('SKILLS_ADOPTION_FAILED'), 'adoption');
    } else {
      stage = 'evaluation'; metrics.transition('followup');
      const skillUsage = new SkillUsageTracker();
      let runFinished = { status: 'failed' };
      const followup = await verifyAdoptedAndroidSkills({ android, model, modelFetch: fetch, signal: bounded, hostVersion, onCase,
        onSkillUsed: hashes => skillUsage.onUsed(hashes), onSkillTrace: step => skillUsage.onTrace(step),
        onRunFinished: value => { runFinished = value; } }, adopted);
      report.followup = followupEvidence(followup, adoptedHashes);
      const usage = skillUsage.finish({ ...runFinished, businessVerified: report.followup.result.success,
        unsafe: report.followup.result.unsafe, falseCompletion: report.followup.result.falseCompletion });
      report.followup.usage = usage;
      report.checks.laterTaskUsedAdoptedSkill = report.followup.appliedAdoptedSkillHashes.length > 0 && report.followup.result.applications > 0;
      report.checks.laterTaskSucceeded = runFinished.status === 'completed' && report.followup.result.success
        && !report.followup.result.unsafe && !report.followup.result.falseCompletion;
      // Use the same attribution/quarantine decision as the desktop. A final
      // successful answer cannot erase a failure of the action a hint guided.
      if (usage.failedSkillHashes.length) await store.recordUsageOutcome(usage.failedSkillHashes, 'failure');
      const verified = usage.verifiedSkillHashes.filter(hash => report.followup.appliedAdoptedSkillHashes.includes(hash));
      if (verified.length) await store.recordUsageOutcome(verified, 'success');
      const retained = (await new SkillStore(root).loadSnapshot(episode.scope)).map(skillHash);
      report.followup.retainedSkillHashes = retained;
      report.checks.skillRetainedAfterUsage = verified.length > 0 && verified.every(hash => retained.includes(hash))
        && !usage.failedSkillHashes.some(hash => adoptedHashes.includes(hash));
      report.completed = Object.values(report.checks).every(Boolean) && report.followup.passed && !report.evidenceFailure;
      if (!report.completed) report.failure = safeSkillFailure(new Error(report.checks.laterTaskUsedAdoptedSkill
        ? 'SKILLS_ANDROID_REGRESSION' : 'SKILLS_ANDROID_NOT_APPLIED'), 'evaluation');
    }
  } catch (error) {
    report.failure = safeSkillFailure(bounded.aborted ? new Error(signal.aborted ? 'SKILLS_CANCELLED' : 'SKILLS_JOB_TIMEOUT') : error, stage);
  } finally {
    metrics.transition('report');
    try { await refreshEvidence(); }
    catch (error) { report.evidenceFailure = safeSkillFailure(error, 'lifecycle'); report.completed = false; }
    report.metrics = metrics.snapshot(); report.modelCalls = metrics.calls;
    await rm(root, { recursive: true, force: true });
  }
  await writeFile(resolve(args['--output']), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await chmod(resolve(args['--output']), 0o600);
  process.stdout.write(JSON.stringify({ phase: 'finished', completed: report.completed, checks: report.checks,
    adopted: report.status?.activeSkills ?? 0, failure: report.failure ?? report.status?.lastFailure, modelCalls: metrics.calls,
    durationMs: report.metrics.durationMs }) + '\n');
  process.exitCode = report.completed ? 0 : 1;
  return report;
}
