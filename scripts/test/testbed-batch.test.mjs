import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDeviceLease, openBatchJournal, BatchBudget, batchHash } from '../testbed-batch.mjs';

const identity = { suite: 'suite-v1', config: 'config-hash', model: 'synthetic-model' };
const code = value => error => error.code === value;
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tappilot-batch-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function budget(t, options = {}) {
  const instance = new BatchBudget({ maxCases: 3, maxModelRequests: 3, maxDurationMs: 10_000, ...options });
  t.after(() => instance.dispose());
  return instance;
}

test('device lease is exclusive for a live PID and releases only its original owner', async t => {
  const directory = await temporary(t);
  const lease = await acquireDeviceLease({ serial: 'emulator-5580', runId: 'first', directory });
  await assert.rejects(acquireDeviceLease({ serial: 'emulator-5580', runId: 'second', directory }), code('DEVICE_LEASE_BUSY'));
  const owner = JSON.parse(await readFile(lease.path));
  assert.equal(owner.pid, process.pid); assert.equal(owner.runId, 'first');
  await writeFile(lease.path, JSON.stringify({ ...owner, runId: 'replacement' }));
  await assert.rejects(lease.release(), code('DEVICE_LEASE_NOT_OWNER'));
  assert.equal(JSON.parse(await readFile(lease.path)).runId, 'replacement');
  await writeFile(lease.path, JSON.stringify(owner));
  await lease.release(); await lease.release();
  await assert.rejects(stat(lease.path), { code: 'ENOENT' });
});

test('stale confirmed-dead owner is recoverable and simultaneous contenders cannot both own it', async t => {
  const directory = await temporary(t);
  const deadPid = 2_147_483_647;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  await writeFile(path.join(directory, 'emulator-5580.json'), JSON.stringify({ serial: 'emulator-5580', pid: deadPid, runId: 'dead', nonce: 'old' }));
  const candidates = await Promise.allSettled(['a', 'b', 'c'].map(runId => acquireDeviceLease({ serial: 'emulator-5580', runId, directory })));
  const winners = candidates.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  await winners[0].value.release();
  await assert.rejects(acquireDeviceLease({ serial: 'physical-device', runId: 'no', directory }), code('INVALID_DEVICE_LEASE'));
});

test('invalid owner PID is not treated as dead', async t => {
  const directory = await temporary(t);
  const leasePath = path.join(directory, 'emulator-5580.json');
  await writeFile(leasePath, JSON.stringify({ serial: 'emulator-5580', pid: 0, runId: 'bad' }));
  await assert.rejects(acquireDeviceLease({ serial: 'emulator-5580', runId: 'new', directory }), code('DEVICE_LEASE_BUSY'));
  assert.equal(JSON.parse(await readFile(leasePath)).pid, 0);
});

test('journal resumes complete cases, discards only unfinished tail and requires exact identity', async t => {
  const directory = await temporary(t), journalPath = path.join(directory, 'results.jsonl');
  const journal = await openBatchJournal({ path: journalPath, identity });
  await journal.append('navigation:17:1', { status: 'success', metrics: { modelRequests: 2 } });
  await journal.close();
  await appendFile(journalPath, '{"type":"case","caseId":"incomplete');
  await assert.rejects(openBatchJournal({ path: journalPath, identity: { ...identity, model: 'other' }, resume: true }), code('BATCH_IDENTITY_MISMATCH'));
  const resumed = await openBatchJournal({ path: journalPath, identity, resume: true });
  assert.equal(resumed.completed.size, 1);
  assert.equal(resumed.completed.get('navigation:17:1').metrics.modelRequests, 2);
  await assert.rejects(resumed.append('navigation:17:1', { status: 'success' }), code('DUPLICATE_CASE_REPORT'));
  await resumed.append('navigation:29:1', { status: 'failed', errorCode: 'TARGET_CHANGED' });
  await resumed.close();
  const rows = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].caseId, 'navigation:29:1');
  await assert.rejects(openBatchJournal({ path: journalPath, identity }), code('BATCH_JOURNAL_EXISTS'));
});

test('journal rejects unsafe/non-JSON/oversized values and validates complete records', async t => {
  const directory = await temporary(t), journalPath = path.join(directory, 'results.jsonl');
  const journal = await openBatchJournal({ path: journalPath, identity });
  for (const value of [{ credentials: { apiKey: 'secret' } }, { result: new Date() }, { value: undefined }, { value: Number.NaN }]) {
    await assert.rejects(journal.append('bad', value), error => ['UNSAFE_CASE_REPORT', 'INVALID_CASE_REPORT'].includes(error.code));
  }
  await assert.rejects(journal.append('large', { label: 'a'.repeat(1024 * 1024) }), code('CASE_REPORT_TOO_LARGE'));
  await journal.close();
  await appendFile(journalPath, '{broken-complete-record}\n');
  await assert.rejects(openBatchJournal({ path: journalPath, identity, resume: true }), code('BATCH_JOURNAL_INVALID'));
  assert.equal(batchHash({ z: 1, a: [2, 3] }), batchHash({ a: [2, 3], z: 1 }));
});

test('request budget counts failed attempts and retries, preserves request body and records numeric usage only', async t => {
  const instance = budget(t, { maxModelRequests: 2 });
  let requests = 0;
  const originalBody = JSON.stringify({ model: 'synthetic', messages: [{ role: 'user', content: 'not persisted' }] });
  const wrapped = instance.wrapFetch(async (_url, init) => {
    requests++; assert.equal(init.body, originalBody); assert.ok(init.signal);
    assert.equal(JSON.parse(init.body).max_tokens, undefined);
    if (requests === 1) throw new Error('network rejected');
    return Response.json({ usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, choices: [{ message: { content: 'not retained' } }] });
  });
  await assert.rejects(wrapped('https://never-contacted.invalid', { body: originalBody }));
  const response = await wrapped('https://never-contacted.invalid', { body: originalBody });
  assert.equal((await response.json()).choices[0].message.content, 'not retained');
  await assert.rejects(wrapped('https://never-contacted.invalid'), code('BATCH_REQUEST_LIMIT'));
  assert.equal(requests, 2);
  assert.deepEqual({ ...instance.snapshot(), elapsedMs: 0 }, { casesStarted: 0, modelRequests: 2, inputTokens: 11, outputTokens: 7, totalTokens: 18, usageResponses: 1, elapsedMs: 0 });
});

test('case and duration limits and parent cancellation stop work before new dispatch', async t => {
  assert.throws(() => new BatchBudget({ maxCases: 1, maxModelRequests: 1, maxDurationMs: 2_147_483_648 }), code('INVALID_BATCH_BUDGET'));
  const cases = budget(t, { maxCases: 1 });
  assert.equal(cases.startCase(), 1);
  assert.throws(() => cases.startCase(), code('BATCH_CASE_LIMIT'));
  const duration = budget(t, { maxDurationMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(duration.signal.aborted, true);
  await assert.rejects(duration.wrapFetch(() => assert.fail('no dispatch'))('https://never-contacted.invalid'), code('BATCH_DURATION_LIMIT'));
  const parent = new AbortController(), child = budget(t, { signal: parent.signal });
  parent.abort();
  assert.throws(() => child.startCase(), code('BATCH_ABORTED'));
});

test('resume counts apply globally; usage reading is bounded and SSE is not consumed', async t => {
  const resumed = budget(t, { maxCases: 2, maxModelRequests: 2, initial: { casesStarted: 1, modelRequests: 1, elapsedMs: 50 } });
  assert.equal(resumed.startCase(), 2);
  const wrapped = resumed.wrapFetch(async () => Response.json({ usage: { input_tokens: 4, output_tokens: 2 } }));
  await wrapped('https://never-contacted.invalid');
  assert.equal(resumed.snapshot().totalTokens, 6);
  assert.equal(resumed.snapshot().modelRequests, 2);
  assert.ok(resumed.snapshot().elapsedMs >= 50);
  const bounded = budget(t, { usageReadTimeoutMs: 15 });
  const streaming = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } });
  const before = performance.now();
  // A referenced timer represents the fetch consumer while the bookkeeping timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await bounded.wrapFetch(async () => streaming)('https://never-contacted.invalid');
    assert.equal(result, streaming); assert.ok(performance.now() - before < 900);
    void streaming.body.cancel();
  } finally { clearTimeout(keepAlive); }
  const sse = new Response('data: synthetic\n\n', { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await bounded.wrapFetch(async () => sse)('https://never-contacted.invalid'), sse);
  assert.equal(await sse.text(), 'data: synthetic\n\n');
  assert.equal(bounded.snapshot().usageResponses, 0);
});

test('budget checkpoint is durable without a completed case and rejects unknown/non-monotonic fields', async t => {
  const directory = await temporary(t), journalPath = path.join(directory, 'results.jsonl');
  const journal = await openBatchJournal({ path: journalPath, identity });
  const instance = budget(t, { beforeModelRequest: snapshot => journal.checkpoint(snapshot) });
  instance.startCase();
  await journal.checkpoint(instance.snapshot());
  await instance.wrapFetch(async () => {
    const rows = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).type, 'budget');
    assert.equal(rows.at(-1).budget.modelRequests, 1);
    return Response.json({ usage: { input_tokens: 3, output_tokens: 2 } });
  })('https://never-contacted.invalid');
  await journal.checkpoint(instance.snapshot());
  const state = journal.latestBudget;
  assert.equal(state.modelRequests, 1); assert.equal(state.totalTokens, 5);
  state.modelRequests = 0;
  assert.equal(journal.latestBudget.modelRequests, 1);
  await assert.rejects(journal.checkpoint({ ...instance.snapshot(), apiKey: 'never persist this' }), code('INVALID_BUDGET_CHECKPOINT'));
  await assert.rejects(journal.checkpoint({ ...instance.snapshot(), modelRequests: 0 }), code('BUDGET_CHECKPOINT_REGRESSION'));
  await journal.close();
  await appendFile(journalPath, '{"type":"budget","budget":');
  const resumed = await openBatchJournal({ path: journalPath, identity, resume: true });
  assert.equal(resumed.completed.size, 0);
  assert.equal(resumed.latestBudget.modelRequests, 1);
  assert.equal(resumed.latestBudget.totalTokens, 5);
  await resumed.close();
});

test('failed checkpoint or cancellation during persistence prevents provider dispatch', async t => {
  const failed = budget(t, { beforeModelRequest: async () => { throw new Error('do not reveal storage exception'); } });
  await assert.rejects(failed.wrapFetch(() => assert.fail('no dispatch'))('https://never-contacted.invalid'), code('BATCH_CHECKPOINT_FAILED'));
  assert.equal(failed.signal.aborted, true);
  assert.equal(failed.snapshot().modelRequests, 1);
  const parent = new AbortController();
  const cancelled = budget(t, { signal: parent.signal, beforeModelRequest: async () => parent.abort() });
  await assert.rejects(cancelled.wrapFetch(() => assert.fail('no dispatch'))('https://never-contacted.invalid'), code('BATCH_ABORTED'));
});

test('interrupted attempt remains resumable with its budget and can later coexist with a completed case', async t => {
  const directory = await temporary(t), journalPath = path.join(directory, 'results.jsonl');
  const journal = await openBatchJournal({ path: journalPath, identity });
  const instance = budget(t, { beforeModelRequest: snapshot => journal.checkpoint(snapshot) });
  instance.startCase(); await journal.checkpoint(instance.snapshot());
  await instance.wrapFetch(async () => Response.json({}))('https://never-contacted.invalid');
  await journal.checkpoint(instance.snapshot());
  await journal.appendAttempt('navigation:17:1', { status: 'interrupted', caseError: 'BATCH_ABORTED', budget: instance.snapshot() });
  await assert.rejects(journal.appendAttempt('navigation:17:1', { apiKey: 'must not persist' }), code('UNSAFE_CASE_REPORT'));
  assert.equal(journal.completed.size, 0);
  assert.equal(journal.attempts.length, 1);
  const returned = journal.attempts; returned[0].report.caseError = 'changed_by_consumer';
  assert.equal(journal.attempts[0].report.caseError, 'BATCH_ABORTED');
  await journal.close();
  const resumed = await openBatchJournal({ path: journalPath, identity, resume: true });
  assert.equal(resumed.completed.has('navigation:17:1'), false);
  assert.equal(resumed.attempts[0].caseId, 'navigation:17:1');
  assert.equal(resumed.latestBudget.modelRequests, 1);
  assert.equal(resumed.latestBudget.casesStarted, 1);
  await resumed.append('navigation:17:1', { status: 'success' });
  await resumed.close();
  const complete = await openBatchJournal({ path: journalPath, identity, resume: true });
  assert.equal(complete.completed.get('navigation:17:1').status, 'success');
  assert.equal(complete.attempts.length, 1);
  await complete.close();
  const rows = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.type === 'attempt').length, 1);
  assert.equal(rows.filter(row => row.type === 'case').length, 1);
});

test('killing a process during a provider request cannot erase that request from resume budget', async t => {
  const directory = await temporary(t), journalPath = path.join(directory, 'results.jsonl');
  const source = `
    import { openBatchJournal, BatchBudget } from ${JSON.stringify(new URL('../testbed-batch.mjs', import.meta.url).href)};
    const journal = await openBatchJournal({ path: process.argv[1], identity: ${JSON.stringify(identity)} });
    const budget = new BatchBudget({ maxCases: 3, maxModelRequests: 1, maxDurationMs: 10000,
      beforeModelRequest: snapshot => journal.checkpoint(snapshot) });
    budget.startCase(); await journal.checkpoint(budget.snapshot());
    setInterval(() => {}, 1000);
    await budget.wrapFetch(async () => {
      process.stdout.write('REQUEST_STARTED\\n');
      return new Promise(() => {});
    })('https://never-contacted.invalid');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, journalPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child request did not start')), 5000);
    child.stdout.once('data', chunk => {
      clearTimeout(timeout);
      if (chunk.toString().includes('REQUEST_STARTED')) resolve(); else reject(new Error('unexpected child output'));
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('child exited before request')); });
  });
  child.kill('SIGKILL'); await exited;
  const resumed = await openBatchJournal({ path: journalPath, identity, resume: true });
  assert.equal(resumed.completed.size, 0);
  assert.equal(resumed.latestBudget.casesStarted, 1);
  assert.equal(resumed.latestBudget.modelRequests, 1);
  const instance = budget(t, { maxModelRequests: 1, initial: resumed.latestBudget });
  await assert.rejects(instance.wrapFetch(() => assert.fail('no repeat request after resume'))('https://never-contacted.invalid'), code('BATCH_REQUEST_LIMIT'));
  await resumed.close();
});
