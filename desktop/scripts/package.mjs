import { packager } from '@electron/packager';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Stage only the reviewed bundle and local assets; never package source, tests, keys or node_modules.
const stage = path.join(root, '.package');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, main: 'dist/main.cjs', productName: 'TapPilot', description: manifest.description }));
const outputs = await packager({ dir: stage, out: path.join(root, 'release'), name: 'TapPilot', executableName: 'TapPilot', appBundleId: 'dev.tappilot.desktop', appVersion: manifest.version, electronVersion: manifest.devDependencies.electron, platform: 'darwin', arch: process.arch, asar: true, overwrite: true, prune: false, darwinDarkModeSupport: true });
for (const output of outputs) process.stdout.write(`${path.join(output, 'TapPilot.app')}\n`);
