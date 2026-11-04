/**
 * vitest 全局准备。
 *
 * pdfjs 4.x 用到 `Promise.withResolvers`（Node 22+ 才有）。本机是 Node 20，
 * 所以这里补一个 polyfill —— 浏览器端旧 Safari 同理（见 apps/web/src/polyfills.ts）。
 */

import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

import { setPdfAssetUrls } from '../src/parse/pdfText';

if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== 'function') {
  (Promise as unknown as { withResolvers: () => unknown }).withResolvers = function withResolvers() {
    let resolve: unknown;
    let reject: unknown;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/**
 * 测试里也要给 pdfjs 指 CMap 目录。
 *
 * Node 的 pdfjs 用 `fs.readFile(baseUrl + name + '.bcmap')`，所以这里给的是
 * 文件系统路径而不是 URL。不配的话，用 CID 字体又没有 ToUnicode 的真实老票
 * 会「有文字层但全是乱码」—— 测试会以「字段全空」的形式红掉，却看不出原因。
 */
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(
  dirname(dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'))),
);
setPdfAssetUrls({
  cMapUrl: join(pdfjsRoot, 'cmaps') + sep,
  standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + sep,
});
