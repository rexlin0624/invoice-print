/**
 * 主线程上 pdfjs 的唯一入口。
 *
 * 为什么要有这个文件：pdfjs 要求 `GlobalWorkerOptions.workerSrc` 被设置过才能 `getDocument()`，
 * 否则直接抛 `No "GlobalWorkerOptions.workerSrc" specified.`。
 * 内核里的 `setPdfWorkerSrc()` 只在**内核自己**懒加载 pdfjs 时才把它设上，
 * 所以任何在主线程静态用 pdfjs 的模块都可能在内核还没加载 pdfjs 之前先跑，
 * 于是拿到一个没配 worker 的实例。
 *
 * 结论：**主线程**要用 pdfjs 就从这里 import —— 这个模块在被 import 的那一刻就把 worker 配好。
 * ⚠️ 它必须在 `polyfills` 之后被 import（pdfjs 4 依赖 `Promise.withResolvers`）。
 *
 * 谁还在主线程用 pdfjs：内核的文字层解析（`packages/core/src/parse/pdfText.ts`）。
 * 渲染类的用法（缩略图、二维码、裁白边、栅格化、OCR 前处理）**已经全部搬进 Worker**，
 * 那边由 `lib/render/engine.ts` 自己配 worker 地址（见 `lib/render.worker.ts` 的说明）。
 */

import { setPdfWorkerSrc } from '@invoice-tool/core';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// 内核随后懒加载 pdfjs 时，也能拿到同一个 worker
setPdfWorkerSrc(workerUrl);

export { pdfjs };
