/**
 * 准备离线 OCR 资源（把 tesseract 的运行时与中文语言模型放进 public/ocr/）。
 *
 * 为什么要有这一步：tesseract.js 默认从 jsDelivr CDN 拉 **worker / wasm 核心 / 语言模型**
 * 三样东西。这个项目承诺「文件不上传、仅在本机处理」，而且断网也要能用，
 * 所以三样都必须落在本地。
 *
 * 用法：
 *   node scripts/prepare-ocr.mjs           # 复制运行时；模型缺失就下载
 *   node scripts/prepare-ocr.mjs --force   # 连模型一起重新下载
 *   node scripts/prepare-ocr.mjs --no-model  # 只复制运行时，不碰模型
 *
 * 产物：apps/web/public/ocr/{worker.min.js, tesseract-core-lstm.wasm.js, chi_sim.traineddata.gz}
 * public/ocr/ 已 gitignore（20 MB 的模型不适合进版本库），所以新克隆的机器要跑一次。
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(WEB_ROOT, '../..');
const OUT_DIR = join(WEB_ROOT, 'public', 'ocr');

/**
 * 语言模型固定在这个 commit 上。
 * 用固定版本而不是「最新」：模型变了识别结果就会变，回归基线会失效。
 * 这份是 tesseract 官方 tessdata 的 4.0.0 chi_sim（含简体中文 + 拉丁字母 + 数字）。
 */
const MODEL = {
  name: 'chi_sim.traineddata.gz',
  url: 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/chi_sim.traineddata.gz',
  /** 实测校验值：下载完成后比对，被代理截断/替换的文件会在这一步被拦下 */
  sha256: '59388039851e4d1293d729c183fd8c1fa9bbbb959eed996e945024671e68c1d6',
  bytes: 20_159_757,
};

/**
 * 只复制 `-lstm` 的**非 SIMD** 版本。
 *
 * 三个理由：
 * - 它是纯 WASM 基线版，任何浏览器都能跑（SIMD 版只在中国/新内核上更快）
 * - 传具体 `.js` 会让 tesseract 跳过特性探测，行为可预测
 * - 单文件版把 wasm 内嵌在 js 里，只需要一个文件
 */
const RUNTIME = [
  {
    from: 'tesseract.js/dist/worker.min.js',
    to: 'worker.min.js',
  },
  {
    from: 'tesseract.js-core/tesseract-core-lstm.wasm.js',
    to: 'tesseract-core-lstm.wasm.js',
  },
];

/** node_modules 里被 pnpm 硬链接的包：按名字找它的真实目录 */
async function packageDir(name) {
  const direct = join(REPO_ROOT, 'node_modules', name);
  try {
    const s = await stat(direct);
    if (s.isDirectory()) return direct;
  } catch {
    /* 继续找 .pnpm */
  }
  // pnpm 的布局：node_modules/.pnpm/<name>@<ver>*/node_modules/<name>
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(store).catch(() => []);
  const hit = entries.filter((e) => e.startsWith(`${name}@`)).sort().pop();
  if (!hit) throw new Error(`找不到依赖 ${name}（先跑 pnpm install）`);
  return join(store, hit, 'node_modules', name);
}

async function exists(path) {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function downloadModel(force) {
  const target = join(OUT_DIR, MODEL.name);
  if (!force && (await exists(target))) {
    const size = (await stat(target)).size;
    if (size === MODEL.bytes) {
      console.log(`✓ 语言模型已在：${MODEL.name}（${(size / 1048576).toFixed(1)} MB）`);
      return;
    }
    console.log(`⚠ 已有的 ${MODEL.name} 大小不对（${size} ≠ ${MODEL.bytes}），重新下载`);
  }

  console.log(`↓ 下载语言模型 ${MODEL.name}（约 20 MB，一次性）…`);
  const res = await fetch(MODEL.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // gzip 魔数校验：网络被中间设备截断时最容易拿到的就是半个文件
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error('下载到的不是 gzip（可能被代理拦截了）');
  }

  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== MODEL.sha256) {
    // 不写盘：宁可让这一步失败，也不要把一个「看起来能用」的模型放进运行时
    throw new Error(
      `语言模型校验失败（拿到 ${sha}，期望 ${MODEL.sha256}）。\n` +
        '可能是代理替换了文件。若确认上游已更新模型，请同步更新本脚本里的 sha256。',
    );
  }

  await writeFile(target, bytes);
  console.log(
    `✓ 语言模型就位：${MODEL.name}（${(bytes.length / 1048576).toFixed(1)} MB，sha256 校验通过）`,
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });

  for (const item of RUNTIME) {
    const dir = await packageDir(item.from.split('/')[0]);
    const from = join(dir, item.from.split('/').slice(1).join('/'));
    if (!(await exists(from))) throw new Error(`缺少 ${from}`);
    await copyFile(from, join(OUT_DIR, item.to));
    const size = (await readFile(join(OUT_DIR, item.to))).length;
    console.log(`✓ ${item.to}（${(size / 1024).toFixed(0)} KB）`);
  }

  if (!args.has('--no-model')) await downloadModel(args.has('--force'));

  console.log(`\nOCR 资源目录：${OUT_DIR}`);
}

await main();
