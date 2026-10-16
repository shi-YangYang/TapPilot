#!/usr/bin/env node
// Real MCP stdio -> ADB -> AccessibilityService integration smoke.
// Does not approve actions, use fixed coordinates, or store UI content.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'server/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'server/dist/index.js')],
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  stderr: 'inherit',
});
const client = new Client({ name: 'tappilot-device-smoke', version: '0.1.0' });

async function call(name, args = {}) {
  const started = performance.now();
  const reply = await client.callTool({ name, arguments: args });
  const text = reply.content?.find((entry) => entry.type === 'text')?.text;
  assert.ok(text, `${name}: missing structured response`);
  const envelope = JSON.parse(text);
  if (reply.isError || !envelope.ok) {
    throw new Error(`${name}: ${envelope.error?.code ?? 'FAILED'} — ${envelope.error?.message ?? 'Request failed'}`);
  }
  console.log(`PASS ${name} (${Math.round(performance.now() - started)} ms)`);
  return envelope.result;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['get_device_info', 'get_current_app', 'get_ui_tree', 'find_element', 'open_settings']) {
    assert.ok(tools.some((tool) => tool.name === name), `Missing tool ${name}`);
  }
  await call('get_device_info');
  await call('open_settings');
  // Wait on actual window/content events, not a fixed sleep. A selector checks
  // the current tree first so already-completed transitions are also observed.
  await call('wait_for_ui_change', {
    sinceRevision: 0,
    timeoutMs: 10000,
    selector: { textContains: process.env.TAPPILOT_SETTINGS_LABEL ?? '设置' },
  });
  const app = await call('get_current_app');
  const tree = await call('get_ui_tree', { maxNodes: 300, maxDepth: 20 });
  assert.ok(tree.snapshotId && Number.isInteger(tree.revision), 'Missing snapshot identity');
  assert.ok(Array.isArray(tree.nodes) && tree.nodes.length > 0, 'No accessible nodes');
  assert.ok(typeof tree.packageName === 'string' && /settings/i.test(tree.packageName),
    'The active package is not a recognizable Settings app; inspect the device manually');
  assert.ok(tree.nodes.every((node) => typeof node.nodeId === 'string'), 'Invalid node references');
  await call('find_element', { selector: { scrollable: true }, maxResults: 5 });
  console.log(`PASS real device: app=${app.packageName ?? tree.packageName}, nodes=${tree.nodes.length}, truncated=${tree.truncated}`);
  console.log('Bridge smoke complete. For dynamic Settings → Battery navigation, run scripts/acceptance.sh.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Device smoke failed');
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
