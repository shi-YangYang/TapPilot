// Batch mechanics only. Never retain model requests, responses, credentials or UI content.
import { open, mkdir, readFile, stat, link, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class BatchError extends Error {
  constructor(code) { super(code); this.name = 'BatchError'; this.code = code; }
}
const fail = code => { throw new BatchError(code); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const missing = error => error?.code === 'ENOENT';
const MAX_RECORD_BYTES = 1024 * 1024;
const BUDGET_FIELDS = ['casesStarted', 'modelRequests', 'inputTokens', 'outputTokens', 'totalTokens', 'usageResponses', 'elapsedMs'];

function checkedBudget(snapshot, previous) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join(',') !== [...BUDGET_FIELDS].sort().join(',')) fail('INVALID_BUDGET_CHECKPOINT');
  const result = {};
  for (const key of BUDGET_FIELDS) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0) fail('INVALID_BUDGET_CHECKPOINT');
    if (previous && snapshot[key] < previous[key]) fail('BUDGET_CHECKPOINT_REGRESSION');
    result[key] = snapshot[key];
  }
  return result;
}

function confirmedDead(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; } // EPERM and unknown failures are not proof of death.
}

/** A fully written candidate is linked atomically, so readers never see a half-written owner. */
export async function acquireDeviceLease({ serial, runId, directory = path.join(tmpdir(), 'tappilot-testbed-leases') }) {
  if (!/^emulator-\d+$/.test(serial) || typeof runId !== 'string' || !/^[\w-]{1,100}$/.test(runId)) fail('INVALID_DEVICE_LEASE');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const leasePath = path.join(directory, `${serial}.json`);
  const owner = { schemaVersion: 1, serial, pid: process.pid, runId, nonce: randomUUID() };
  const candidate = `${leasePath}.${owner.nonce}.candidate`;
  const candidateHandle = await open(candidate, 'wx', 0o600);
  try { await candidateHandle.writeFile(JSON.stringify(owner)); await candidateHandle.sync(); }
  finally { await candidateHandle.close(); }
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await link(candidate, leasePath);
        const ownedStat = await stat(leasePath);
        let released = false;
        return { path: leasePath, async release() {
          if (released) return;
          let currentStat, current;
          try { currentStat = await stat(leasePath); current = JSON.parse(await readFile(leasePath, 'utf8')); }
          catch (error) { if (missing(error)) { released = true; return; } fail('DEVICE_LEASE_NOT_OWNER'); }
          if (!sameFile(ownedStat, currentStat) || current.nonce !== owner.nonce || current.pid !== process.pid || current.runId !== runId) fail('DEVICE_LEASE_NOT_OWNER');
          await unlink(leasePath);
          released = true;
        } };
      } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      let staleStat, stale;
      try { staleStat = await stat(leasePath); stale = JSON.parse(await readFile(leasePath, 'utf8')); }
      catch (error) { if (missing(error)) continue; fail('DEVICE_LEASE_INVALID'); }
      if (stale.serial !== serial || !confirmedDead(stale.pid)) fail('DEVICE_LEASE_BUSY');
      // Only one process may reclaim this inode. A crash while reclaiming fails closed:
      // leave the tombstone for inspection instead of risking removal of a live lease.
      const reaperPath = `${leasePath}.${staleStat.dev}.${staleStat.ino}.reaping`;
      let reaper;
      try { reaper = await open(reaperPath, 'wx', 0o600); }
      catch (error) { if (error?.code === 'EEXIST') fail('DEVICE_LEASE_RECOVERY_BUSY'); throw error; }
      try {
        await reaper.writeFile(JSON.stringify({ pid: process.pid, runId }));
        let currentStat, current;
        try { currentStat = await stat(leasePath); current = JSON.parse(await readFile(leasePath, 'utf8')); }
        catch (error) { if (missing(error)) continue; fail('DEVICE_LEASE_INVALID'); }
        if (!sameFile(staleStat, currentStat) || current.nonce !== stale.nonce || current.pid !== stale.pid || !confirmedDead(current.pid)) continue;
        await unlink(leasePath);
      } finally { await reaper.close(); await unlink(reaperPath); }
    }
    fail('DEVICE_LEASE_BUSY');
  } finally { await unlink(candidate).catch(() => {}); }
}

function checkedIdentity(identity) {
  if (!identity || Object.keys(identity).sort().join(',') !== 'config,model,suite') fail('INVALID_BATCH_IDENTITY');
  const result = {};
  for (const key of ['suite', 'config', 'model']) {
    const value = identity[key];
    if (typeof value !== 'string' || !/^[\w.:/@+-]{1,200}$/.test(value) || value.includes('://') || /^sk-|^bearer/i.test(value)) fail('INVALID_BATCH_IDENTITY');
    result[key] = value;
  }
  return result;
}
export function batchHash(value) {
  const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function checkedReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('INVALID_CASE_REPORT');
  const visit = (value, depth = 0) => {
    if (depth > 20) fail('INVALID_CASE_REPORT');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_CASE_REPORT');
    for (const [key, item] of Object.entries(value)) {
      if (/^(api.?key|authorization|base.?url|endpoint|headers|messages|prompt|task|content|observation|nodes|requestBody|responseBody)$/i.test(key)) fail('UNSAFE_CASE_REPORT');
      visit(item, depth + 1);
    }
  };
  visit(report);
  const value = JSON.stringify(report);
  if (Buffer.byteLength(value) > MAX_RECORD_BYTES) fail('CASE_REPORT_TOO_LARGE');
  return JSON.parse(value);
}

/** Durable complete-case records. A truncated last line is not a completed case. */
export async function openBatchJournal({ path: journalPath, identity, resume = false }) {
  const expected = checkedIdentity(identity);
  const header = { type: 'header', schemaVersion: 1, identity: expected };
  const completed = new Map();
  const attempts = [];
  let latestBudget;
  await mkdir(path.dirname(path.resolve(journalPath)), { recursive: true, mode: 0o700 });
  let handle;
  if (!resume) {
    try { handle = await open(journalPath, 'wx', 0o600); }
    catch (error) { if (error?.code === 'EEXIST') fail('BATCH_JOURNAL_EXISTS'); throw error; }
    await handle.writeFile(`${JSON.stringify(header)}\n`); await handle.sync();
  } else {
    try { handle = await open(journalPath, 'r+', 0o600); }
    catch (error) { if (missing(error)) fail('BATCH_JOURNAL_MISSING'); throw error; }
    try {
      if ((await handle.stat()).size > 64 * MAX_RECORD_BYTES) fail('BATCH_JOURNAL_TOO_LARGE');
      const buffer = await handle.readFile();
      const end = buffer.lastIndexOf(10) + 1;
      if (!end) fail('BATCH_JOURNAL_INVALID');
      const lines = buffer.subarray(0, end).toString('utf8').trimEnd().split('\n');
      let found;
      try { found = JSON.parse(lines.shift()); } catch { fail('BATCH_JOURNAL_INVALID'); }
      if (found.type !== 'header' || found.schemaVersion !== 1 || batchHash(found.identity) !== batchHash(expected)) fail('BATCH_IDENTITY_MISMATCH');
      for (const line of lines) {
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES + 1024) fail('BATCH_JOURNAL_INVALID');
        let row;
        try { row = JSON.parse(line); } catch { fail('BATCH_JOURNAL_INVALID'); }
        if (row.type === 'budget') {
          if (Object.keys(row).sort().join(',') !== 'budget,type') fail('BATCH_JOURNAL_INVALID');
          latestBudget = checkedBudget(row.budget, latestBudget);
          continue;
        }
        if (!['case', 'attempt'].includes(row.type) || typeof row.caseId !== 'string' || !/^[\w:.-]{1,200}$/.test(row.caseId) || completed.has(row.caseId)) fail('BATCH_JOURNAL_INVALID');
        if (row.type === 'attempt') {
          if (Object.keys(row).sort().join(',') !== 'caseId,report,type') fail('BATCH_JOURNAL_INVALID');
          attempts.push({ caseId: row.caseId, report: checkedReport(row.report) });
        } else completed.set(row.caseId, checkedReport(row.report));
      }
      await handle.truncate(end); // Incomplete final write is rerun; complete earlier records remain.
    } catch (error) { await handle.close(); throw error; }
    await handle.close();
    handle = await open(journalPath, 'a', 0o600);
  }
  let pending = Promise.resolve(), closed = false, failed = false;
  const enqueue = callback => {
    if (closed || failed) fail('BATCH_JOURNAL_CLOSED');
    const operation = pending.then(async () => {
      if (failed) fail('BATCH_JOURNAL_CLOSED');
      return callback(async row => {
        try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync(); }
        catch (error) { failed = true; throw error; }
      });
    });
    pending = operation.catch(() => {});
    return operation;
  };
  return { completed, get attempts() { return structuredClone(attempts); }, get latestBudget() { return latestBudget ? { ...latestBudget } : undefined; }, async append(caseId, report) {
    if (typeof caseId !== 'string' || !/^[\w:.-]{1,200}$/.test(caseId)) fail('INVALID_CASE_ID');
    const safe = checkedReport(report);
    return enqueue(async write => {
      if (completed.has(caseId)) fail('DUPLICATE_CASE_REPORT');
      await write({ type: 'case', caseId, report: safe });
      completed.set(caseId, safe);
    });
  }, async appendAttempt(caseId, report) {
    if (typeof caseId !== 'string' || !/^[\w:.-]{1,200}$/.test(caseId)) fail('INVALID_CASE_ID');
    const safe = checkedReport(report);
    return enqueue(async write => {
      if (completed.has(caseId)) fail('DUPLICATE_CASE_REPORT');
      await write({ type: 'attempt', caseId, report: safe });
      attempts.push({ caseId, report: safe });
    });
  }, async checkpoint(snapshot) {
    const safe = checkedBudget(snapshot);
    return enqueue(async write => {
      checkedBudget(safe, latestBudget);
      await write({ type: 'budget', budget: safe });
      latestBudget = safe;
      return { ...safe };
    });
  }, async close() { if (closed) return; closed = true; await pending; await handle.close(); } };
}

async function usageFrom(response, signal, timeoutMs) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return undefined;
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  let timer, onAbort;
  const stop = new Promise(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs); timer.unref?.();
    onAbort = () => resolve(undefined);
    if (signal.aborted) resolve(undefined); else signal.addEventListener('abort', onAbort, { once: true });
  });
  const parse = async () => {
    let length = 0; const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 256 * 1024) return undefined;
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8'))?.usage; } catch { return undefined; }
  };
  try { return await Promise.race([parse().catch(() => undefined), stop]); }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    // Awaiting cancellation of one tee branch could wait for the consumer of the other.
    void reader.cancel().catch(() => {});
  }
}

export class BatchBudget {
  constructor({ maxCases, maxModelRequests, maxDurationMs, signal, initial = {}, usageReadTimeoutMs = 1000, beforeModelRequest }) {
    for (const value of [maxCases, maxModelRequests, maxDurationMs, usageReadTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_BATCH_BUDGET');
    if (maxDurationMs > 2_147_483_647 || usageReadTimeoutMs > 2_147_483_647) fail('INVALID_BATCH_BUDGET');
    if (beforeModelRequest !== undefined && typeof beforeModelRequest !== 'function') fail('INVALID_BATCH_BUDGET');
    this.beforeModelRequest = beforeModelRequest;
    this.limits = { maxCases, maxModelRequests, maxDurationMs };
    this.usageReadTimeoutMs = usageReadTimeoutMs;
    this.counts = { casesStarted: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, usageResponses: 0 };
    for (const key of Object.keys(this.counts)) {
      if (initial[key] !== undefined && (!Number.isSafeInteger(initial[key]) || initial[key] < 0)) fail('INVALID_BATCH_BUDGET');
      this.counts[key] = initial[key] ?? 0;
    }
    this.elapsedBefore = initial.elapsedMs ?? 0;
    if (!Number.isFinite(this.elapsedBefore) || this.elapsedBefore < 0) fail('INVALID_BATCH_BUDGET');
    this.started = performance.now();
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.parentSignal = signal;
    this.onAbort = () => this.controller.abort(new BatchError('BATCH_ABORTED'));
    if (signal?.aborted) this.onAbort(); else signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timer = setTimeout(() => this.controller.abort(new BatchError('BATCH_DURATION_LIMIT')), Math.max(1, maxDurationMs - this.elapsedBefore));
    this.timer.unref?.();
  }
  assertAvailable() {
    if (this.signal.aborted) throw this.signal.reason;
    if (this.snapshot().elapsedMs >= this.limits.maxDurationMs) this.stop('BATCH_DURATION_LIMIT');
  }
  stop(code) { const error = new BatchError(code); this.controller.abort(error); throw error; }
  startCase() {
    this.assertAvailable();
    if (this.counts.casesStarted >= this.limits.maxCases) this.stop('BATCH_CASE_LIMIT');
    return ++this.counts.casesStarted;
  }
  wrapFetch(fetchImpl = globalThis.fetch) {
    return async (input, init = {}) => {
      this.assertAvailable();
      if (this.counts.modelRequests >= this.limits.maxModelRequests) this.stop('BATCH_REQUEST_LIMIT');
      const requestSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = requestSignal ? AbortSignal.any([this.signal, requestSignal]) : this.signal;
      signal.throwIfAborted();
      ++this.counts.modelRequests; // Reserve before dispatch; network errors and retries still consume a request.
      // Persist the reservation before the provider can receive a request. An interrupted case
      // therefore still consumes its attempts after resume, even without a completed-case row.
      if (this.beforeModelRequest) {
        try { await this.beforeModelRequest(this.snapshot()); }
        catch { this.stop('BATCH_CHECKPOINT_FAILED'); }
      }
      this.assertAvailable();
      signal.throwIfAborted();
      const response = await fetchImpl(input, { ...init, signal });
      const usage = await usageFrom(response, signal, this.usageReadTimeoutMs);
      if (usage && typeof usage === 'object') {
        const token = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
        const inputTokens = token(usage.prompt_tokens) ?? token(usage.input_tokens);
        const outputTokens = token(usage.completion_tokens) ?? token(usage.output_tokens);
        const totalTokens = token(usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
        if ([inputTokens, outputTokens, totalTokens].some(value => value !== undefined)) {
          ++this.counts.usageResponses;
          this.counts.inputTokens += inputTokens ?? 0; this.counts.outputTokens += outputTokens ?? 0; this.counts.totalTokens += totalTokens ?? 0;
        }
      }
      return response;
    };
  }
  snapshot() { return { ...this.counts, elapsedMs: Math.floor(this.elapsedBefore + performance.now() - this.started) }; }
  dispose() { clearTimeout(this.timer); this.parentSignal?.removeEventListener('abort', this.onAbort); }
}
