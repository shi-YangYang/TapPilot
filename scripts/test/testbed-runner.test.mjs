import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArguments, makeCases, summarizeReports, trackOperation, drainOperations } from '../testbed-runner.mjs';

const definitions = JSON.parse(await readFile(new URL('../../android/testbed/scenarios.json', import.meta.url)));

test('batch selection is reproducible and an exact failure case can be replayed', () => {
  const args = parseArguments(['--scenes', 'navigation,async_list', '--seeds', '17,29', '--repeat', '2']);
  const cases = makeCases(definitions, args);
  assert.equal(cases.length, 8);
  assert.deepEqual(makeCases(definitions, args), cases);
  assert.deepEqual(makeCases(definitions, { ...args, caseIds: cases[5].caseId }), [cases[5]]);
  assert.throws(() => makeCases(definitions, { ...args, caseIds: 'unknown' }), /UNKNOWN_CASE/);
  const holdout = makeCases(definitions, { ...args, split: 'holdout' });
  assert.notDeepEqual(holdout[0].scenario.variant, cases[0].scenario.variant);
});

test('invalid budgets, duplicate seeds and typo flags fail before any device access', () => {
  for (const argv of [['--max-model-requests', '0'], ['--case-timeout-ms', '700000'], ['--repeat', 'NaN'],
    ['--seeds', '17,17'], ['--serial'], ['--allow-physical'], ['--resume'],
    ['--decision-delay-ms', '-1'], ['--mode', 'model', '--decision-delay-ms', '2500']]) {
    assert.throws(() => parseArguments(argv));
  }
  assert.equal(parseArguments(['--decision-delay-ms', '2500']).decisionDelayMs, 2500);
});

test('configured disturbances are never counted as observed coverage', () => {
  const summary = summarizeReports([
    { status: 'success', coverage: ['async_replace'], observedCoverage: [], wrongClicks: 0 },
    { status: 'correct_refusal', coverage: ['async_replace'], observedCoverage: ['refresh_progress_observed'], wrongClicks: 0 },
  ], 3, { modelRequests: 8 }, 'BATCH_REQUEST_LIMIT');
  assert.equal(summary.pendingCases, 1);
  assert.deepEqual(summary.configuredCoverage, { async_replace: 2 });
  assert.deepEqual(summary.observedCoverage, { refresh_progress_observed: 1 });
  assert.equal(summary.stopReason, 'BATCH_REQUEST_LIMIT');
});

test('successful tasks still expose action refusals and interrupted attempts remain pending', () => {
  const attempt = { caseId: 'next', report: { status: 'interrupted' } };
  const summary = summarizeReports([{ status: 'success', steps: [
    { action: null, ok: false, dispatchState: 'not_applicable' },
    { action: 'tap_element', ok: false, dispatchState: 'not_sent', error: 'TARGET_CHANGED' },
    { action: 'tap_element', ok: true, dispatchState: 'sent' },
  ] }], 2, {}, undefined, [attempt]);
  assert.equal(summary.completedCases, 1);
  assert.equal(summary.pendingCases, 1);
  assert.deepEqual(summary.interruptedAttempts, [attempt]);
  assert.deepEqual(summary.actionEvidence, { calls: 2, failedCalls: 1, confirmedNotSent: 1, unknownDispatch: 0, errors: { TARGET_CHANGED: 1 } });
});

test('case cleanup waits for an aborted tool callback before allowing another reset', async () => {
  const active = new Set();
  let release;
  let recorded = false;
  const task = trackOperation(active, async () => {
    await new Promise(resolve => { release = resolve; });
    recorded = true;
    throw new Error('cancelled');
  });
  const caught = task.catch(() => {});
  await Promise.resolve();
  assert.equal(await drainOperations(active, 5), false);
  assert.equal(recorded, false);
  release();
  assert.equal(await drainOperations(active, 1000), true);
  await caught;
  assert.equal(recorded, true);
  assert.equal(active.size, 0);
});
