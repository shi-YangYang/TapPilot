import { build } from 'esbuild';
import { copyFile, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const entry of ['runtime/index.js', 'client-tools.js', 'wireless.js']) {
  try { await access(path.join(root, '../server/dist', entry)); }
  catch { throw new Error('请先在 server 目录运行 npm run build，再构建桌面客户端。'); }
}
await mkdir(path.join(root, 'dist'), { recursive: true });
await build({ entryPoints: [path.join(root, 'src/main.mjs')], outfile: path.join(root, 'dist/main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false, logLevel: 'info' });
await build({ entryPoints: [path.join(root, 'src/renderer.tsx')], outfile: path.join(root, 'dist/renderer.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome148', jsx: 'automatic', alias: { '@': path.join(root, 'src/beui') }, define: { 'process.env.NODE_ENV': '"production"' }, minify: true, sourcemap: false, logLevel: 'info' });
const stylesheet = path.join(root, 'src/theme.css');
const css = await postcss([tailwindcss({ base: root, optimize: true })]).process(await readFile(stylesheet, 'utf8'), { from: stylesheet, to: path.join(root, 'dist/styles.css') });
await writeFile(path.join(root, 'dist/styles.css'), css.css);
for (const name of ['index.html', 'preload.cjs']) await copyFile(path.join(root, 'src', name), path.join(root, 'dist', name));
await copyFile(path.join(root, 'src/beui/LICENSE'), path.join(root, 'dist/beui-LICENSE.txt'));
await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(root, 'dist/THIRD_PARTY_NOTICES.md'));
for (const name of ['Geist-Variable.woff2', 'Geist-LICENSE.txt']) await copyFile(path.join(root, 'src/assets', name), path.join(root, 'dist', name));
