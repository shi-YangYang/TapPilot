import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPriorEpisodeReport } from '../skill-learning-episode.mjs';
import { modelScope } from '../../server/dist/learning/schema.js';
import { SKILL_POLICY_REVISION } from '../../server/dist/skills/schema.js';
import { compactTrace, createEpisode, episodeFingerprint } from '../../server/dist/skills/trace.js';

const model = { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'synthetic-test-only', model: 'synthetic-model' };
const options = { model, hostVersion: '0.3.19' };
function sourceReport() {
  const trigger = { actionKind: 'input_text', errorCode: 'TARGET_CHANGED', reason: 'PAGE_CONTEXT_CHANGED' };
  const ui = { snapshotId: 'synthetic:1', packageName: 'dev.tappilot.testbed', windowId: 1, truncated: false,
    nodes: [{ nodeId: 'input', editable: true, enabled: true, visible: true }, { nodeId: 'label' }] };
  const step = compactTrace({ index: 1, before: ui, after: { ...ui, snapshotId: 'synthetic:2', changedLabelNodeIds: ['label'] }, targetNodeId: 'input',
    diagnostic: { ...trigger, dispatchState: 'not_sent', acceptanceState: 'rejected', effectState: 'unknown', executor: 'node-v1',
      contextChange: { region: 'outside_target', kind: 'content', changedNodes: 1, targetMatched: true, actionTargetMatched: true } } });
  const episode = createEpisode({ scope: { hostVersion: options.hostVersion, policyRevision: SKILL_POLICY_REVISION,
    modelProfile: modelScope(model).modelProfile, appDigest: createHash('sha256').update('dev.tappilot.testbed').digest('hex') },
    trigger, steps: [step], termination: 'completed', appliedSkillHashes: [] });
  return { schemaVersion: 2, source: 'real_android_synthetic_fixture', productionStoreModified: false, episode };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tappilot-episode-import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.json');
  return { dir, path, write: report => writeFile(path, JSON.stringify(report), { mode: 0o600 }) };
}

test('imports only the strictly validated failure and exact source provenance, never adopted state', async t => {
  const f = await fixture(t), report = sourceReport();
  Object.assign(report, { completed: true, candidates: [{ state: 'active', spec: 'untrusted' }],
    validation: { contract: 'android_recovery' }, adoptedPrograms: ['untrusted'], checks: { evaluationPassed: true } });
  const bytes = JSON.stringify(report);
  await f.write(report);
  const result = await readPriorEpisodeReport(f.path, options);
  assert.deepEqual(result, { episode: report.episode, captureSource: 'prior_report', captureCalls: 0,
    sourceReportHash: createHash('sha256').update(bytes).digest('hex'), episodeFingerprint: episodeFingerprint(report.episode) });
  // A task can have recovered after a genuine rejection. Its original identity,
  // timestamp and completed termination must not be rewritten into a new failure.
  assert.equal(result.episode.termination, 'completed');
});

test('requires the current model, host, policy and exact fixed fixture app scope', async t => {
  const f = await fixture(t);
  for (const [field, value] of [['hostVersion', '0.3.18'], ['modelProfile', 'b'.repeat(64)],
    ['appDigest', 'c'.repeat(64)], ['appDigest', undefined], ['policyRevision', 'other-policy']]) {
    const report = sourceReport(); report.episode.scope[field] = value;
    await f.write(report);
    await assert.rejects(readPriorEpisodeReport(f.path, options), /^(?:Error: )?(?:SKILLS_SCOPE_MISMATCH|SKILL_INVALID_EPISODE)$/);
  }
  await f.write(sourceReport());
  await assert.rejects(readPriorEpisodeReport(f.path, { ...options, model: { ...model, model: 'another-model' } }), /SKILLS_SCOPE_MISMATCH/);
});

test('requires a real native input refusal with matching context evidence', async t => {
  const f = await fixture(t);
  const mutations = [
    report => { delete report.episode.steps[0].executor; },
    report => { report.episode.steps[0].dispatchState = 'sent'; },
    report => { report.episode.steps[0].acceptanceState = 'accepted'; },
    report => { delete report.episode.steps[0].contextChange; },
    report => { report.episode.steps[0].contextChange.targetMatched = false; },
    report => { report.episode.steps[0].contextChange.actionTargetMatched = false; },
    report => { report.episode.trigger.actionKind = report.episode.steps[0].actionKind = 'tap_element'; },
  ];
  for (const mutate of mutations) {
    const report = sourceReport(); mutate(report); await f.write(report);
    await assert.rejects(readPriorEpisodeReport(f.path, options), /SKILLS_ANDROID_UNREPRODUCIBLE|SKILL_INVALID_EPISODE/);
  }
});

test('rejects invalid envelopes, raw episode fields and malformed or oversized source files', async t => {
  const f = await fixture(t);
  const mutations = [
    report => { report.source = 'untrusted'; }, report => { report.schemaVersion = 1; },
    report => { report.productionStoreModified = true; }, report => { report.episode.rawUi = 'synthetic-private'; },
    report => { report.episode.steps[0].rawText = 'synthetic-private'; },
    report => { report.episode.steps = []; },
  ];
  for (const mutate of mutations) {
    const report = sourceReport(); mutate(report); await f.write(report);
    await assert.rejects(readPriorEpisodeReport(f.path, options), { message: 'SKILL_INVALID_EPISODE' });
  }
  for (const data of ['', '{invalid-private-data', Buffer.alloc(1024 * 1024 + 1), Buffer.from([0xff])]) {
    await writeFile(f.path, data);
    await assert.rejects(readPriorEpisodeReport(f.path, options), { message: 'SKILL_INVALID_EPISODE' });
  }
});

test('refuses symlinks and non-files with fixed errors, and honors cancellation before reading', async t => {
  const f = await fixture(t); await f.write(sourceReport());
  const link = join(f.dir, 'link.json'); await symlink(f.path, link);
  for (const path of [link, f.dir, join(f.dir, 'missing-private-name')])
    await assert.rejects(readPriorEpisodeReport(path, options), { message: 'SKILL_INVALID_EPISODE' });
  const signal = AbortSignal.abort(new Error('SKILLS_CANCELLED'));
  await assert.rejects(readPriorEpisodeReport(f.path, { ...options, signal }), { message: 'SKILLS_CANCELLED' });
});
