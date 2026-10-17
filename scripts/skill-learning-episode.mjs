// Resume a rehearsal from a previously captured, sanitized failure only. A
// source report is never an authority for candidates, evaluation or adoption.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { modelScope } from '../server/dist/learning/schema.js';
import { SKILL_POLICY_REVISION } from '../server/dist/skills/schema.js';
import { FailureEpisodeSchema, episodeFingerprint } from '../server/dist/skills/trace.js';

const maxReportBytes = 1024 * 1024;
const fixtureAppDigest = createHash('sha256').update('dev.tappilot.testbed').digest('hex');
const fail = code => { throw new Error(code); };

export async function readPriorEpisodeReport(path, { model, hostVersion, signal }) {
  signal?.throwIfAborted();
  let file, bytes;
  try {
    // Refuse symlinks and non-regular files; cap both the stat and actual read.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxReportBytes) fail('SKILL_INVALID_EPISODE');
    const buffer = Buffer.alloc(maxReportBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!length || length > maxReportBytes) fail('SKILL_INVALID_EPISODE');
    bytes = buffer.subarray(0, length);
  } catch { fail('SKILL_INVALID_EPISODE'); }
  finally { await file?.close(); }
  signal?.throwIfAborted();

  let episode;
  try {
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (report?.schemaVersion !== 2 || report.source !== 'real_android_synthetic_fixture'
      || report.productionStoreModified !== false) fail('SKILL_INVALID_EPISODE');
    // Explicit projection: all other fields, including successful validations
    // and adopted programs, are deliberately ignored rather than restored.
    episode = FailureEpisodeSchema.parse(report.episode);
  } catch { fail('SKILL_INVALID_EPISODE'); }
  let modelProfile;
  try { ({ modelProfile } = modelScope(model)); }
  catch { fail('SKILL_INVALID_MODEL'); }
  if (episode.scope.hostVersion !== hostVersion || episode.scope.policyRevision !== SKILL_POLICY_REVISION
    || episode.scope.modelProfile !== modelProfile || episode.scope.appDigest !== fixtureAppDigest) fail('SKILLS_SCOPE_MISMATCH');
  const trigger = episode.trigger;
  const nativeInputFailure = trigger.actionKind === 'input_text' && trigger.errorCode === 'TARGET_CHANGED'
    && trigger.reason === 'PAGE_CONTEXT_CHANGED' && episode.steps.some(step => step.actionKind === trigger.actionKind
      && step.errorCode === trigger.errorCode && step.reason === trigger.reason && step.executor === 'node-v1'
      && step.dispatchState === 'not_sent' && step.acceptanceState === 'rejected'
      && step.contextChange?.kind === 'content'
      && ['outside_target', 'peer_item'].includes(step.contextChange.region)
      && step.contextChange.targetMatched && step.contextChange.actionTargetMatched);
  if (!nativeInputFailure) fail('SKILLS_ANDROID_UNREPRODUCIBLE');
  return { episode, captureSource: 'prior_report', captureCalls: 0,
    sourceReportHash: createHash('sha256').update(bytes).digest('hex'),
    episodeFingerprint: episodeFingerprint(episode) };
}
