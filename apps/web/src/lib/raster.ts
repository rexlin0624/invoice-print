/**
 * 栅格化：裁白边、黑白打印、老打印机兼容。
 *
 * 三件事都需要「把一页变成像素」，所以放一起。它们都是**外壳能力**：
 * 内核只负责几何（见 `packages/core/src/layout`），像素交给
 * `render/client.ts`（默认在 **Worker** 里画，主线程不卡、标签页不可见也能画完）。
 *
 * ⚠️ 内存纪律：本机是 8 GB 的 MacBook Air，一页 A4 在 300 dpi 下是
 * 2480×3508 ≈ 8.7 M 像素 ≈ 35 MB 的 RGBA 缓冲。所以：
 * - 每次只处理一页，画布用完就让它被回收（不要攒数组）
 * - 检测白边只用 72 dpi
 * - 默认 200 dpi 而不是 300 dpi（打印质量与内存/体积之间取平衡，
 *   参考实现用 300 是因为它在原生端；浏览器里 200 dpi 已经看不出差别）
 *
 * 渲染引擎还额外保证**同一时刻只画一张**（Worker 里串行排队），
 * 并发渲染两张 A4@200dpi 才是这台机器真正的危险区。
 */

import type { Box } from './box';
import { renderPage, resultBytes } from './render/client';
import type { RenderResult } from './render/types';

export type { Box };

/** 1 英寸 = 72 pt：`dpi` 与倍率之间的换算就靠它 */
const PT_PER_INCH = 72;
/** 白边探测用的分辨率：只找边界，不看细节 */
const DETECT_DPI = 72;
/** 栅格化默认分辨率 */
const RASTER_DPI = 200;
/** JPEG 质量（灰度照片型内容） */
const JPEG_QUALITY = 0.85;

export interface RasterOptions {
  /** 渲染分辨率，默认 200。图片**默认按原像素 1:1**，给了它才缩放 */
  dpi?: number;
  /** 裁成纯黑白（阈值化） */
  blackWhite?: boolean;
  /** 只渲染这个区域（页面坐标，pt） */
  box?: Box;
}

export interface RasterImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  /** 图像对应的物理尺寸（pt），排版用 */
  widthPt: number;
  heightPt: number;
}

/** 渲染结果 → 排版要用的图片。黑白用 PNG（线条图压缩率高、边缘干净），否则 JPEG。 */
function rasterOf(result: RenderResult): RasterImage {
  return {
    bytes: resultBytes(result),
    mime: result.mime === 'image/png' ? 'image/png' : 'image/jpeg',
    widthPt: result.region.w,
    heightPt: result.region.h,
  };
}

/**
 * 找出页面里**有内容的范围**（去掉四周白边），pt，左上原点。
 *
 * 返回 `undefined` 表示「不值得裁」：
 * - 几乎整页都是内容（裁了也没意义，反而会因为四舍五入抖一点点）
 * - 或者根本没找到内容（空页）
 */
export async function detectContentBox(data: Uint8Array, pageIndex: number): Promise<Box | undefined> {
  const result = await renderPage(data, {
    kind: 'pdf',
    pageIndex,
    dpi: DETECT_DPI,
    detectInk: true,
    encode: null,
  }).catch(() => undefined);
  return result?.inkBox ?? undefined;
}

/**
 * 把一页（或其中一块）渲染成图片。
 *
 * 图片类型：黑白用 PNG（线条图压缩率极高且边缘干净），灰度用 JPEG（照片型内容小得多）。
 */
export async function rasterizePage(
  data: Uint8Array,
  pageIndex: number,
  options: RasterOptions = {},
): Promise<RasterImage | undefined> {
  const blackWhite = options.blackWhite === true;
  const result = await renderPage(data, {
    kind: 'pdf',
    pageIndex,
    box: options.box ?? null,
    dpi: options.dpi ?? RASTER_DPI,
    blackWhite,
    encode: blackWhite ? 'image/png' : 'image/jpeg',
    quality: JPEG_QUALITY,
  }).catch(() => undefined);
  return result ? rasterOf(result) : undefined;
}

/**
 * 图片文件（png/jpg）也走「裁白边 / 黑白」。
 * 与 PDF 不同的是它没有文字层，所以尺寸来自图片本身的像素。
 */
export async function rasterizeImage(
  data: Uint8Array,
  options: RasterOptions = {},
): Promise<RasterImage | undefined> {
  const blackWhite = options.blackWhite === true;
  const result = await renderPage(data, {
    kind: 'image',
    box: options.box ?? null,
    // 图片没有「英寸」概念：默认 1:1 出图；显式给了 dpi 才按它缩放
    scale: options.dpi ? options.dpi / PT_PER_INCH : 1,
    blackWhite,
    encode: blackWhite ? 'image/png' : 'image/jpeg',
    quality: JPEG_QUALITY,
  }).catch(() => undefined);
  return result ? rasterOf(result) : undefined;
}

/** 图片文件的像素尺寸 */
export async function imageSize(data: Uint8Array): Promise<{ width: number; height: number } | undefined> {
  const result = await renderPage(data, { kind: 'image', probe: true }).catch(() => undefined);
  return result ? { width: result.base.width, height: result.base.height } : undefined;
}

/** 图片文件的内容边界（像素即坐标） */
export async function detectImageContentBox(data: Uint8Array): Promise<Box | undefined> {
  const result = await renderPage(data, {
    kind: 'image',
    scale: 1,
    detectInk: true,
    encode: null,
  }).catch(() => undefined);
  return result?.inkBox ?? undefined;
}
