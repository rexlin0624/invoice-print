#!/usr/bin/env node
/**
 * 诊断工具：把一个 PDF 的文字层按「行」dump 出来（含坐标）。
 *
 * 用途：写/修字段提取规则前，先看真实版式，不要靠猜坐标。
 *   node scripts/dump-pdf-text.mjs <file.pdf> [--json]
 *
 * 这是命令行诊断工具，不属于内核。内核永远是 I/O-free 的纯函数。
 */

// pdfjs 4.x 需要 Promise.withResolvers（Node 22+）。旧 Node 补一下。
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) {
  console.error('用法: node scripts/dump-pdf-text.mjs <file.pdf> [--json]');
  process.exit(2);
}

const fs = await import('node:fs/promises');
const data = new Uint8Array(await fs.readFile(file));

const doc = await pdfjs.getDocument({
  data,
  useSystemFonts: false,
  isEvalSupported: false,
  disableFontFace: true,
  verbosity: 0,
}).promise;

const out = { file, pages: [] };

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();

  // transform = [a b c d e f]，e/f 是 PDF 用户空间坐标（原点左下）
  const tokens = tc.items
    .filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
    .map((it) => ({
      text: it.str,
      x: Number(it.transform[4].toFixed(2)),
      // 翻成「y 向下」，和后续 CSS 预览一致
      y: Number((vp.height - it.transform[5]).toFixed(2)),
      w: Number(it.width.toFixed(2)),
      h: Number(it.height.toFixed(2)),
    }));

  // 按 y 聚成行（容差 2pt）。注意 token 的 y 基线会有微小差异，
  // 所以先按 y 分band，再在 band 内严格按 x 排序 —— 否则会得到非阅读顺序。
  const sorted = [...tokens].sort((a, b) => a.y - b.y);
  const bands = [];
  for (const t of sorted) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.y - t.y) <= 2) last.tokens.push(t);
    else bands.push({ y: t.y, tokens: [t] });
  }
  const lines = bands.map((b) => {
    b.tokens.sort((a, c) => a.x - c.x);
    return {
      y: Number(b.tokens.reduce((s, t) => s + t.y, 0) / b.tokens.length),
      x1: Math.min(...b.tokens.map((t) => t.x)),
      x2: Math.max(...b.tokens.map((t) => t.x + t.w)),
      tokens: b.tokens,
    };
  });
  out.pages.push({
    page: p,
    width: Number(vp.width.toFixed(2)),
    height: Number(vp.height.toFixed(2)),
    tokenCount: tokens.length,
    lines: lines.map((l) => ({
      y: l.y,
      x: l.x1,
      text: l.tokens.map((t) => t.text).join(''),
      spans: l.tokens.length,
      tokens: l.tokens.map((t) => ({ t: t.text, x: t.x, w: t.w })),
    })),
  });
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const page of out.pages) {
    console.log(
      `\n===== 第 ${page.page} 页  ${page.width} × ${page.height} pt  (${page.tokenCount} 个 token) =====`,
    );
    for (const l of page.lines) {
      console.log(`y=${String(l.y).padStart(7)}  x=${String(l.x).padStart(7)}  ${l.text}`);
    }
  }
}
