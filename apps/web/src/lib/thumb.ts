/**
 * 把 PDF 的某一页（可只渲染其中一块）渲染成缩略图（dataURL）。
 *
 * 为什么用真渲染而不是「信息卡」：设计稿的预览就是票面本身，
 * 而且用户一眼要能看出「这张票有没有歪、有没有截断」。
 *
 * 渲染本身不在这里：统一走 `render/client.ts`（默认在 **Worker** 里跑，
 * 于是导入一叠票时主线程不卡，标签页不可见也能画完 —— 见 `render.worker.ts`）。
 * 这个文件只负责「要什么」与缓存。
 *
 * 倍率语义是**预览专用**的：至少 1.5 倍像素密度，打印预览才不糊；
 * 上限 4 倍防止小票被放大成巨图。
 * ⚠️ 区域渲染参数由内核 `regionRenderArgs()` 给：viewport 必须是 `scale: 1`，
 * 缩放只写在 transform 里，否则会被平方（见 `docs/打印与导出参考.md` §7）。
 */

import type { Box } from './box';
import { renderPage, resultDataUrl } from './render/client';

/** 预览至少按 1.5 倍像素密度渲染 */
const PREVIEW_DENSITY = 1.5;
/** 倍率上限：小票别被放大成巨图 */
const MAX_SCALE = 4;
const JPEG_QUALITY = 0.86;

const cache = new Map<string, Promise<string | undefined>>();

/**
 * 按「文件 + 页码 + 裁剪框 + 目标宽度」缓存，避免同一张票重复渲染。
 * key 用 sha256（内容指纹）而不是文件名：同名不同内容不会串。
 */
export function thumbnailFor(
  key: string,
  data: Uint8Array,
  maxWidth: number,
  page = 0,
  box?: Box,
): Promise<string | undefined> {
  const cacheKey = `${key}|p${page}|${box ? `${box.x},${box.y},${box.w},${box.h}` : 'full'}|${maxWidth}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const task = render(data, maxWidth, page, box).catch(() => undefined);
  cache.set(cacheKey, task);
  return task;
}

/** 内容变更（比如换了裁剪框）时把缓存清掉 */
export function forgetThumbnails(key?: string): void {
  if (key === undefined) cache.clear();
  else {
    for (const k of [...cache.keys()]) if (k.startsWith(`${key}|`)) cache.delete(k);
  }
}

export interface ImageInfo {
  width: number;
  height: number;
}

/**
 * 图片票（png/jpg）的缩略图。
 * 与 PDF 走同一条渲染路，只是没有页码概念。
 */
export function imageThumbnailFor(
  key: string,
  data: Uint8Array,
  maxWidth: number,
  box?: Box,
): Promise<string | undefined> {
  const cacheKey = `${key}|img|${box ? `${box.x},${box.y},${box.w},${box.h}` : 'full'}|${maxWidth}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const task = renderImage(data, maxWidth, box).catch(() => undefined);
  cache.set(cacheKey, task);
  return task;
}

async function renderImage(data: Uint8Array, maxWidth: number, box?: Box): Promise<string | undefined> {
  const result = await renderPage(data, {
    kind: 'image',
    box: box ?? null,
    maxWidthPx: maxWidth * PREVIEW_DENSITY,
    maxScale: MAX_SCALE,
    encode: 'image/jpeg',
    quality: JPEG_QUALITY,
  });
  return resultDataUrl(result);
}

async function render(
  data: Uint8Array,
  maxWidth: number,
  pageIndex: number,
  box: Box | undefined,
): Promise<string | undefined> {
  const result = await renderPage(data, {
    kind: 'pdf',
    pageIndex,
    box: box ?? null,
    maxWidthPx: maxWidth * PREVIEW_DENSITY,
    maxScale: MAX_SCALE,
    encode: 'image/jpeg',
    quality: JPEG_QUALITY,
  });
  return resultDataUrl(result);
}
