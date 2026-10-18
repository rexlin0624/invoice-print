/**
 * 渲染引擎：把 PDF 的一页（或一张图片）变成像素 / 图片字节。
 *
 * **一份实现，两个宿主**：Worker（默认，见 `render.worker.ts`）与主线程
 * （老浏览器兜底，见 `render/client.ts`）。为什么必须只有一份 ——
 * 预览缩略图、二维码、裁白边、黑白栅格、OCR 前处理全都要「同一套区域渲染参数」，
 * 各写一份就会各踩一次 `regionRenderArgs` 文件头里那个「缩放被平方」的坑。
 *
 * 这个模块**不许碰 `document`**：它能跑在 Worker 里。唯一的例外是画布与字体，
 * 两者都做了环境探测（`newCanvas()` / `fontEnvironment()`）。
 *
 * ⚠️ 传进来的 `bytes` 会被 pdfjs **转移**走（见 `pdfjsSafe.ts`）。
 * 调用方必须保证这是自己不再用的那一份（客户端统一先 `slice()`）。
 */

import { regionRenderArgs } from '@invoice-tool/core';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

import type { Box } from '../box';
import type { RenderRequest, RenderResult } from './types';

/**
 * pdfjs 自己的解析 worker 地址。
 *
 * 为什么不用 `?url` 直接给的字符串：这段代码也会被打进**worker 分块**，
 * 而 worker 里相对 URL 是相对「那个 worker 文件」解析的。
 * 用 `import.meta.url` 当基准，主线程和 Worker 两条路都能解析对，
 * 也顺便避开了 `base: './'`（桌面端 file:// / 自定义协议）下的相对路径陷阱。
 */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(pdfWorkerUrl, import.meta.url).href;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
/**
 * 2D 上下文。
 *
 * 故意只写 `CanvasRenderingContext2D` 而不是 `... | OffscreenCanvasRenderingContext2D`：
 * 联合类型的**方法调用**在 TS 里要求两边签名完全一致，`drawImage` 这类重载就会报错。
 * 运行时两个对象对我们用到的那几个方法（fillRect / drawImage / getImageData /
 * putImageData / fillStyle）是同构的，所以在这里做一次收敛。
 */
type AnyContext = CanvasRenderingContext2D;

/** 有内容判定阈值：任一通道低于它就认为画到了墨 */
const INK_LEVEL = 245;
/** 阈值化（黑白）的亮度分界 */
const BLACK_WHITE_LEVEL = 170;
/** 缩略图默认像素密度倍率上限（防止小票被放大成巨图） */
const DEFAULT_MAX_SCALE = 4;
/** 1 英寸 = 72 pt（PDF 的用户单位）：`dpi` 换算成倍率用 */
const PT_PER_INCH = 72;

/**
 * 开一块画布。优先 `OffscreenCanvas` —— 它在 Worker 里是唯一选择，
 * 在主线程也能用（省一次 DOM 元素的生命周期管理）。
 */
function newCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 白底画布：有些电子发票页面本身是透明的，透明像素会被当成黑色内容 */
function newContext(width: number, height: number, willRead: boolean): AnyContext {
  const canvas = newCanvas(width, height);
  const ctx = canvas.getContext('2d', {
    willReadFrequently: willRead,
  }) as unknown as AnyContext | null;
  if (!ctx) throw new Error('渲染失败：拿不到 2d 上下文');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

/**
 * pdfjs 的**辅助**画布工厂。
 *
 * 为什么必须自己给一个：pdfjs 默认用 `DOMCanvasFactory`，它调
 * `document.createElement('canvas')` —— Worker 里没有 `document`，
 * 一遇到需要临时画布的内容（蒙版、图案填充）就直接抛异常。
 * 主画布是我们自己传的，走不到这个工厂；**辅助**画布才走它。
 *
 * 接口形状照抄 `BaseCanvasFactory`（create / reset / destroy），
 * 因为 pdfjs 只按这个形状调。
 */
export class RenderCanvasFactory {
  private readonly enableHWA: boolean;

  constructor({ enableHWA = false }: { ownerDocument?: unknown; enableHWA?: boolean } = {}) {
    this.enableHWA = enableHWA;
  }

  create(width: number, height: number): { canvas: AnyCanvas; context: AnyContext } {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = newCanvas(width, height);
    const context = canvas.getContext('2d', {
      willReadFrequently: !this.enableHWA,
    }) as unknown as AnyContext | null;
    if (!context) throw new Error('拿不到 2d 上下文');
    return { canvas, context };
  }

  reset(entry: { canvas: AnyCanvas | null }, width: number, height: number): void {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }

  destroy(entry: { canvas: AnyCanvas | null; context?: AnyContext | null }): void {
    if (!entry.canvas) return;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

/**
 * 字体环境：这个东西决定 pdfjs 用**哪条路**把字形画出来。
 *
 * - 有 `FontFaceSet`（主线程，以及 Chrome 的 Worker —— 那里有 `self.fonts`）：
 *   走 `FontFace`，和本仓库以前在主线程的行为一致。
 * - 没有（老引擎的 Worker）：必须显式 `disableFontFace: true`，让 pdfjs 直接
 *   用**字形轮廓画路径**（内嵌字体数据就够，不需要注册字体）。
 *   不显式关掉的后果是隐蔽的崩溃：pdfjs 会退到「插一条 `@font-face` 规则」的 DOM 路径，
 *   在 Worker 里没有 `document` 可插，渲染当场抛错。
 */
function fontEnvironment(): {
  ownerDocument?: unknown;
  disableFontFace: boolean;
} {
  if (typeof document !== 'undefined') return { disableFontFace: false };

  const fonts = (globalThis as { fonts?: FontFaceSet }).fonts;
  if (fonts) {
    // 只给 pdfjs 需要的那个成员：假 document 越是「像真的」，
    // 越有可能把 pdfjs 引到别的 DOM 分支上去。
    return { ownerDocument: { fonts }, disableFontFace: false };
  }
  return { disableFontFace: true };
}

/** pdfjs 的文档代理类型（从函数签名推出来，免得依赖它的内部类型路径） */
type DocumentProxy = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

/** pdfjs 的装载参数：两个宿主只差字体与画布工厂这一段 */
async function openDocument(bytes: ArrayBuffer): Promise<DocumentProxy> {
  const env = fontEnvironment();
  return pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
    CanvasFactory: RenderCanvasFactory,
    // 见 fontEnvironment()：Worker 里给一个「只有 fonts」的最小文档替身
    ...(env.ownerDocument ? { ownerDocument: env.ownerDocument as HTMLDocument } : {}),
    disableFontFace: env.disableFontFace,
  }).promise;
}

/** 请求里的区域：绝对 `box` > 相对 `boxFrac` > 整页 */
function resolveRegion(args: RenderRequest, base: { width: number; height: number }): Box {
  if (args.box) return args.box;
  if (args.boxFrac) {
    const [x0, y0, x1, y1] = args.boxFrac;
    return {
      x: x0 * base.width,
      y: y0 * base.height,
      w: (x1 - x0) * base.width,
      h: (y1 - y0) * base.height,
    };
  }
  return { x: 0, y: 0, w: base.width, h: base.height };
}

/** 倍率：显式 `scale` > 「按目标宽度」 > `dpi`（默认 200） */
function resolveScale(args: RenderRequest, region: Box): number {
  if (args.scale !== undefined && args.scale > 0) return args.scale;
  if (args.maxWidthPx !== undefined && args.maxWidthPx > 0) {
    return Math.min(args.maxWidthPx / region.w, args.maxScale ?? DEFAULT_MAX_SCALE);
  }
  return (args.dpi ?? 200) / PT_PER_INCH;
}

/** 阈值化成纯黑白（保留白底） */
function threshold(image: ImageData, level = BLACK_WHITE_LEVEL): void {
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000;
    const v = lum < level ? 0 : 255;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
}

/**
 * 从像素里扫出**有内容的边界**（`detectContentBox` / 图片版共用），坐标回落到业务坐标系。
 *
 * 返回 `undefined` 表示「不值得裁」：
 * - 几乎整页都是内容（裁了也没意义，反而会因为四舍五入抖一点点）
 * - 或者根本没找到内容（空页）
 */
function scanInk(image: ImageData, scale: number, origin: { x: number; y: number }): Box | undefined {
  const px = image.data;
  const { width, height } = image;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const at = rowOffset + x * 4;
      if (px[at]! < INK_LEVEL || px[at + 1]! < INK_LEVEL || px[at + 2]! < INK_LEVEL) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  if (bottom < 0 || right < 0) return undefined;

  // 留一点呼吸空间，别把边框线切掉
  const pad = 4;
  const x0 = Math.max(0, left - pad);
  const y0 = Math.max(0, top - pad);
  const x1 = Math.min(width, right + 1 + pad);
  const y1 = Math.min(height, bottom + 1 + pad);

  const coverage = ((x1 - x0) * (y1 - y0)) / (width * height);
  // 覆盖率太高说明本来就没白边；太低说明修剪过猛（多半是噪点），不裁更安全
  if (coverage > 0.97 || coverage < 0.2) return undefined;

  return {
    x: origin.x + x0 / scale,
    y: origin.y + y0 / scale,
    w: (x1 - x0) / scale,
    h: (y1 - y0) / scale,
  };
}

/** 画布 → 图片字节。`OffscreenCanvas` 只有 `convertToBlob`，DOM 画布只有 `toBlob`。 */
function encodeCanvas(canvas: AnyCanvas, mime: string, quality?: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, mime, quality));
}

interface Painted {
  ctx: AnyContext;
  region: Box;
  base: { width: number; height: number };
  scale: number;
  width: number;
  height: number;
}

/** 画完之后的一切：阈值化 / 内容边界 / 编码，两个宿主共用同一段 */
async function finish(painted: Painted, args: RenderRequest): Promise<RenderResult> {
  const { ctx, region, base, scale, width, height } = painted;

  if (args.blackWhite) {
    const image = ctx.getImageData(0, 0, width, height);
    threshold(image);
    ctx.putImageData(image, 0, 0);
  }

  const inkBox = args.detectInk
    ? (scanInk(ctx.getImageData(0, 0, width, height), scale, {
        x: region.x,
        y: region.y,
      }) ?? null)
    : null;

  if (args.encode) {
    const blob = await encodeCanvas(ctx.canvas, args.encode, args.quality ?? 0.85);
    if (!blob) throw new Error('渲染失败：图片编码没成功');
    return {
      width,
      height,
      scale,
      region,
      base,
      bytes: await blob.arrayBuffer(),
      mime: args.encode,
      pixels: null,
      inkBox,
    };
  }

  // 没让编码就是「要像素」：直接把缓冲 transfer 给调用方，ImageData 本身用完就丢
  const image = ctx.getImageData(0, 0, width, height);
  return {
    width,
    height,
    scale,
    region,
    base,
    bytes: null,
    mime: null,
    pixels: image.data.buffer as ArrayBuffer,
    inkBox,
  };
}

/** 渲染 PDF 的一页（可只画其中一块） */
async function renderPdfPage(args: RenderRequest): Promise<RenderResult> {
  const doc = await openDocument(args.bytes);
  try {
    const page = await doc.getPage((args.pageIndex ?? 0) + 1);
    const viewport = page.getViewport({ scale: 1 });
    const base = { width: viewport.width, height: viewport.height };

    if (args.probe) return probeResult(base);

    const region = resolveRegion(args, base);
    if (region.w <= 0 || region.h <= 0) throw new Error('渲染失败：渲染区域为空');
    const scale = resolveScale(args, region);
    const width = Math.max(1, Math.round(region.w * scale));
    const height = Math.max(1, Math.round(region.h * scale));

    const ctx = newContext(width, height, args.encode == null || args.blackWhite === true);
    // 区域渲染参数由内核算（viewport 必须 scale 1，否则缩放会被平方，见 regionRenderArgs）
    await page.render({
      canvasContext: ctx,
      ...regionRenderArgs(page, scale, region),
    }).promise;

    return await finish({ ctx, region, base, scale, width, height }, args);
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

/** 渲染一张图片（png/jpg）：没有文字层，坐标就是像素 */
async function renderImageFile(args: RenderRequest): Promise<RenderResult> {
  const bitmap = await createImageBitmap(new Blob([args.bytes]));
  try {
    const base = { width: bitmap.width, height: bitmap.height };
    if (args.probe) return probeResult(base);

    const region = resolveRegion(args, base);
    if (region.w <= 0 || region.h <= 0) throw new Error('渲染失败：渲染区域为空');
    const scale = resolveScale(args, region);
    const width = Math.max(1, Math.round(region.w * scale));
    const height = Math.max(1, Math.round(region.h * scale));

    const ctx = newContext(width, height, args.encode == null || args.blackWhite === true);
    ctx.drawImage(bitmap, region.x, region.y, region.w, region.h, 0, 0, width, height);

    return await finish({ ctx, region, base, scale, width, height }, args);
  } finally {
    bitmap.close();
  }
}

/** 渲染入口。两个宿主（Worker / 主线程）都调这一个函数。 */
export async function render(args: RenderRequest): Promise<RenderResult> {
  if (args.kind === 'image') return renderImageFile(args);
  return renderPdfPage(args);
}

/** 只量尺寸时的空结果（`probe`） */
function probeResult(base: { width: number; height: number }): RenderResult {
  return {
    width: Math.max(1, Math.round(base.width)),
    height: Math.max(1, Math.round(base.height)),
    scale: 1,
    region: { x: 0, y: 0, w: base.width, h: base.height },
    base,
    bytes: null,
    mime: null,
    pixels: null,
    inkBox: null,
  };
}
