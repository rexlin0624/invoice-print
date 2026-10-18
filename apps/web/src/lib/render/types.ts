/**
 * 「渲染一页」的请求与结果（外壳内部契约，Worker 与主线程共用）。
 *
 * 这份契约要同时喂饱五个用途，所以选项是按**意图**给的，不是按调用点给的：
 * - 预览缩略图：`maxWidthPx`（按宽度定倍率，别把小票放大成巨图）
 * - 二维码 / 白边探测：`dpi` 或 `scale` + `boxFrac` / `box`
 * - 黑白打印 / 老打印机兼容：`blackWhite` + `encode: 'image/png'`
 * - OCR 前处理：`maxWidthPx` + `encode: 'image/png'`（tesseract 不收 ImageData）
 *
 * 坐标系与内核一致：`box` 对 PDF 是页面 pt（左上原点、y 向下），对图片是像素。
 */

import type { Box } from '../box';

/** 渲染对象：PDF 的某一页，或整张图片（图片没有页码概念） */
export type RenderKind = 'pdf' | 'image';

export interface RenderRequest {
  /** 原始字节。**调用方负责先拷贝**：这份会被 transfer 走，见 `pdfjsSafe.ts` */
  bytes: ArrayBuffer;
  kind: RenderKind;
  /** PDF 的 0 基页号；图片忽略 */
  pageIndex?: number;
  /** 绝对区域（PDF 是 pt，图片是 px，左上原点 y 向下）；不传或 null = 整页 */
  box?: Box | null;
  /** 相对区域 `[x0, y0, x1, y1]`，取值 0–1；与 `box` 互斥，二维码扫描用 */
  boxFrac?: readonly [number, number, number, number] | null;
  /** 分辨率（每英寸）。默认 200；`scale` / `maxWidthPx` 优先于它 */
  dpi?: number;
  /** 显式倍率，优先级最高 */
  scale?: number;
  /** 目标宽度（画布 px）：倍率取 `min(maxWidthPx / 区域宽, maxScale)` */
  maxWidthPx?: number;
  /** `maxWidthPx` 的倍率上限，默认 4（防止小票被放大成巨图） */
  maxScale?: number;
  /** 阈值化成纯黑白（保留白底） */
  blackWhite?: boolean;
  /** 有值就回图片字节；不传（null）就回 RGBA 像素 */
  encode?: 'image/jpeg' | 'image/png' | null;
  /** JPEG 质量，默认 0.85 */
  quality?: number;
  /** 顺带在同一个宿主里算出「有内容的边界」（省一次渲染与一次大缓冲搬运） */
  detectInk?: boolean;
  /**
   * 只问尺寸，不画。用于「这张图片多大」这类只需要 `base` 的场合 ——
   * 比先解码再量省掉一次整幅画布与一次 getImageData。
   */
  probe?: boolean;
}

export interface RenderResult {
  /** 画布尺寸（px） */
  width: number;
  height: number;
  /** 实际用的倍率 */
  scale: number;
  /** 渲染覆盖的页面区域（PDF 是 pt，图片是 px） */
  region: Box;
  /** 整页尺寸（PDF 是 pt，图片是 px）：调用方换算坐标要用它 */
  base: { width: number; height: number };
  /** `encode` 有值时的图片字节（transfer 回来） */
  bytes: ArrayBuffer | null;
  mime: string | null;
  /** `encode` 为空时的 RGBA 像素（transfer 回来） */
  pixels: ArrayBuffer | null;
  /** `detectInk` 时的内容边界；没找到内容或没让算就是 null */
  inkBox: Box | null;
}
