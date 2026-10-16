import { build } from 'esbuild';
import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const entry of ['runtime/index.js', 'client-tools.js']) {
  try { await access(path.join(root, '../server/dist', entry)); }
  catch { throw new Error('请先在 server 目录运行 npm run build，再构建桌面客户端。'); }
}
await mkdir(path.join(root, 'dist'), { recursive: true });
await build({ entryPoints: [path.join(root, 'src/main.mjs')], outfile: path.join(root, 'dist/main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false, logLevel: 'info' });
for (const name of ['index.html', 'renderer.js', 'styles.css', 'preload.cjs']) await copyFile(path.join(root, 'src', name), path.join(root, 'dist', name));
