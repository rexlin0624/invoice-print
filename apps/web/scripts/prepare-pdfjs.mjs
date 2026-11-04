#!/usr/bin/env node
/**
 * 准备 pdfjs 的 CMap 与标准字体（复制到 public/pdfjs/）。
 *
 * 为什么需要：PDF 里的中文常用 CID 字体，且不一定带 ToUnicode。pdfjs 只有拿到
 * 对应的 `.bcmap` 才能把字形编码翻回中文；缺了它 `getTextContent()` 仍会返回
 * “文字”，但全是乱码，解析结果就成了一张空票。这是真实老票最常见的坑，
 * 而且不会报错，只会在字段上静默消失。
 *
 * 产物：apps/web/public/pdfjs/{cmaps,standard_fonts}/
 * 两目录合计约 2.4 MB，已 gitignore：它们完全来自 node_modules，能重建。
 * `dev` / `build` 前会自动跑一遍。
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(WEB_ROOT, '../..');
const OUT_DIR = join(WEB_ROOT, 'public', 'pdfjs');

const DIRS = ['cmaps', 'standard_fonts'];

/** node_modules 里被 pnpm 硬链接的包：按名字找它的真实目录 */
async function packageDir(name) {
  const direct = join(REPO_ROOT, 'node_modules', name);
  try {
    const s = await stat(direct);
    if (s.isDirectory()) return direct;
  } catch {
    /* 继续找 .pnpm */
  }
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  const entries = await readdir(store).catch(() => []);
  const hit = entries.filter((e) => e.startsWith(`${name}@`)).sort().pop();
  if (!hit) throw new Error(`找不到依赖 ${name}（先跑 pnpm install）`);
  return join(store, hit, 'node_modules', name);
}

const pdfjs = await packageDir('pdfjs-dist');
await mkdir(OUT_DIR, { recursive: true });

for (const name of DIRS) {
  const from = join(pdfjs, name);
  const to = join(OUT_DIR, name);
  await cp(from, to, { recursive: true, force: true });
  const count = (await readdir(to)).length;
  console.log(`[pdfjs] ${name}: ${count} 个文件 → ${to}`);
}
