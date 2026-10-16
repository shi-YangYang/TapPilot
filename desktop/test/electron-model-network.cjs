// Run with: ./node_modules/.bin/electron test/electron-model-network.cjs
// Synthetic model/proxy only; never loads the user's settings or credentials.
const { app, session } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-model-network-'));
app.setPath('userData', directory);
let proxy;
let target;
let network;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { if (!server) return resolve(); server.closeAllConnections(); server.close(resolve); });
const deadline = setTimeout(() => { process.stderr.write('FAIL model network deadline\n'); app.exit(1); }, 25000);

app.whenReady().then(async () => {
  const { createModelFetch } = await import(pathToFileURL(path.join(__dirname, '../src/model-network.mjs')).href);
  const { testModel } = await import(pathToFileURL(path.join(__dirname, '../../server/dist/runtime/index.js')).href);
  let targetRequests = 0;
  target = createServer((req, res) => { targetRequests++; req.resume(); res.end(); });
  await listen(target);
  // localhost HTTP is the same supported local-model route, but only the proxy returns model JSON.
  const config = { baseUrl: `http://localhost:${target.address().port}/v1`, model: 'synthetic-model', apiKey: 'synthetic-proxy-test-key' };
  const requests = [];
  let behavior = 'ok';
  let pendingRequest;
  proxy = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body: JSON.parse(Buffer.concat(chunks)) });
      if (behavior === 'redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/must-not-receive-key` }); res.end('synthetic private error'); return; }
      if (behavior === 'wait') { pendingRequest?.(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'response-secret=synthetic; Path=/' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
    });
  });
  await listen(proxy);
  network = session.fromPartition('model-network-fixture', { cache: false });
  await network.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${proxy.address().port}`, proxyBypassRules: '<-loopback>' });
  await network.cookies.set({ url: config.baseUrl, name: 'existing-cookie', value: 'synthetic-cookie' });
  const fetchModel = createModelFetch(network);
  assert.equal(network.isPersistent(), false);
  assert.match(await network.resolveProxy(config.baseUrl), /^PROXY /);
  assert.equal((await testModel(config, undefined, fetchModel)).ok, true);
  assert.equal(requests.length, 1);
  assert.equal(targetRequests, 0);
  assert.equal(requests[0].url, `${config.baseUrl}/chat/completions`);
  assert.equal(requests[0].authorization, `Bearer ${config.apiKey}`);
  assert.equal(requests[0].cookie, undefined);
  assert.equal(requests[0].body.model, config.model);
  assert.equal((await network.cookies.get({ name: 'response-secret' })).length, 0);

  behavior = 'redirect';
  await assert.rejects(testModel(config, undefined, fetchModel), error => error.code === 'MODEL_CONNECTION_FAILED' && !error.message.includes(config.apiKey) && !error.message.includes('synthetic private'));
  assert.equal(requests.length, 2); // Redirect is not followed or retried.
  assert.equal(targetRequests, 0);

  behavior = 'wait';
  const controller = new AbortController();
  const received = new Promise(resolve => { pendingRequest = resolve; });
  const operation = testModel(config, controller.signal, fetchModel);
  const rejected = assert.rejects(operation, error => error === controller.signal.reason);
  await received;
  controller.abort(new Error('synthetic cancellation'));
  await rejected;
  assert.equal(requests.length, 3);
  assert.equal(targetRequests, 0);
  process.stdout.write('PASS Electron model proxy transport, explicit authorization, cookie isolation, redirect refusal and cancellation\n');
}).catch(error => {
  process.exitCode = 1;
  process.stderr.write(`FAIL ${error.stack}\n`); // All data in this fixture is synthetic.
}).finally(async () => {
  clearTimeout(deadline);
  await network?.closeAllConnections();
  await close(proxy);
  await close(target);
  rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
