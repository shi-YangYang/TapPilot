// Run after the server build: node test/run-electron-smoke.cjs electron-skills-sqlite.cjs
// Imports only the production persistence module, never desktop main/user settings.
const { app, session } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const assert = require('node:assert/strict');

const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-skills-sqlite-'));
const root = path.join(directory, 'skills');
mkdirSync(root, { mode: 0o700 });
app.setPath('userData', path.join(directory, 'userData'));
app.setPath('sessionData', path.join(directory, 'sessionData'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const timeout = setTimeout(() => finish(1), 15_000);
function finish(code) {
  clearTimeout(timeout);
  rmSync(directory, { recursive: true, force: true });
  if (code) process.stderr.write('SKILLS_SQLITE_ELECTRON_SMOKE_FAILED\n');
  app.exit(code);
}

void (async () => {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_, callback) => callback({ cancel: true }));
  const importServer = name => import(pathToFileURL(path.resolve(__dirname, '../../server/dist/skills', name)).href);
  const { SkillStore } = await importServer('store.js');
  const { compactTrace, createEpisode } = await importServer('trace.js');
  const { SKILL_POLICY_REVISION } = await importServer('schema.js');
  const version = JSON.parse(readFileSync(path.resolve(__dirname, '../../server/package.json'), 'utf8')).version;
  const scope = { hostVersion: version, policyRevision: SKILL_POLICY_REVISION, modelProfile: 'a'.repeat(64) };
  const trigger = { actionKind: 'tap_element', errorCode: 'NODE_NOT_ACTIONABLE', reason: 'NO_CLICKABLE_TARGET' };
  const tree = { snapshotId: 'fixture:1', sessionId: 'fixture', windowId: 1, packageName: 'test.fixture', truncated: false,
    nodes: [{ nodeId: 'target', clickable: false, enabled: true, visible: true }] };
  const step = compactTrace({ index: 1, before: tree, after: tree, targetNodeId: 'target',
    diagnostic: { ...trigger, dispatchState: 'not_sent', acceptanceState: 'rejected', effectState: 'unknown' } });
  const episode = createEpisode({ scope, trigger, steps: [step], termination: 'failed', appliedSkillHashes: [] });
  const store = new SkillStore(root);
  assert.equal((await store.status()).enabled, true);
  const queued = await store.recordEpisode(episode);
  assert.equal(queued.queued, true);
  assert.equal((await store.beginJob(scope.modelProfile)).job.id, queued.id);
  const hash = await store.addCandidate(queued.id, { schemaVersion: 1, scope, trigger, entryConditions: [],
    program: { entry: 0, nodes: [{ kind: 'step', operation: { op: 'inspect', aspect: 'hierarchy' }, next: 1 }, { kind: 'end', outcome: 'continue' }] },
    lineage: { negativeFeedback: [] }, basis: 'hypothesis', expiresAt: Date.now() + 60_000 });
  await store.reserveModelCall(queued.id);
  await store.setEnabled(false);

  const reopened = new SkillStore(root);
  const state = await reopened.status();
  assert.equal(state.enabled, false);
  assert.equal(state.dailyModelCalls, 1);
  const history = await reopened.history();
  assert.equal(history.jobs[0].modelCalls, 1);
  assert.deepEqual(history.skills, [{ hash, state: 'candidate' }]);
  assert.equal((await reopened.loadTaskSnapshot(scope)).length, 0);
  const file = path.join(reopened.directory, 'skills.sqlite3');
  assert.equal(readFileSync(file).subarray(0, 16).toString(), 'SQLite format 3\0');
  const database = new DatabaseSync(file, { readOnly: true });
  let sqlite;
  try {
    sqlite = database.prepare('SELECT sqlite_version() AS version').get().version;
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { database.close(); }
  process.stdout.write(`Skills SQLite Electron smoke passed: candidate/job/settings persist across reopen; Node ${process.versions.node}, SQLite ${sqlite}, Electron ${process.versions.electron}. No phone or model request.\n`);
  finish(0);
})().catch(() => finish(1));
