// A temporary Electron app manifest preserves the real product version in screenshots.
// Usage: node test/run-electron-smoke.cjs electron-smoke.cjs
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const name = process.argv[2];
if (!['electron-smoke.cjs', 'electron-wireless-smoke.cjs'].includes(name)) {
  process.stderr.write('Choose electron-smoke.cjs or electron-wireless-smoke.cjs.\n');
  process.exit(2);
}
const packageInfo = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
const directory = mkdtempSync(path.join(os.tmpdir(), 'tappilot-smoke-launcher-'));
try {
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageInfo.name, productName: 'TapPilot', version: packageInfo.version, main: 'main.cjs' }));
  writeFileSync(path.join(directory, 'main.cjs'), `require(${JSON.stringify(path.join(__dirname, name))});\n`);
  const result = spawnSync(require('electron'), [directory], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch {
  process.stderr.write('Electron smoke launcher failed.\n');
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
