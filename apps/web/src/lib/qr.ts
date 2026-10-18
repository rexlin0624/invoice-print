/**
 * 二维码解码。
 *
 * 职责边界：**内核只认二维码里的字符串，不认图像**。
 * 把图像变成字符串需要栅格化（canvas）与 WASM，这属于外壳能力，
 * 所以放在这里；解出来的原文通过 `ParseInput.qrPayload` 注入内核。
 * 栅格化本身走 `render/client.ts`（默认在 Worker 里画，见 `render.worker.ts`）。
 *
 * ⚠️ 本地优先原则：zxing 默认从 jsDelivr CDN 拉 `.wasm` —— 那既断网不可用，
 * 也跟「文件不上传、仅在本机处理」的承诺相冲。这里用 Vite 的 `?url`
 * 把 wasm 打进产物，并覆盖 `locateFile` 指回本地资源，全程零网络请求。
 *
 * ⚠️ 还有一条纪律：**解二维码失败绝不能让整张票失败**。
 * 调用方一律 `catch` 成 `undefined`，退化成「只有文字层」的正常路径。
 */

import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

import { renderPage, resultPixels } from './render/client';

let prepared: Promise<void> | undefined;

/**
 * 把 wasm 装进 Emscripten 模块。
 *
 * zxing 的胶水代码里**默认**会把 `.wasm` 指向 jsDelivr CDN。那对这个项目是双重问题：
 * 断网就不可用，而且「文件不上传、仅在本机处理」的承诺会被一个 `fetch` 打穿。
 *
 * 这里的做法是**自己把同源 wasm 取回来，直接以 `wasmBinary` 交进去** ——
 * 于是 Emscripten 根本不会去解析路径、也就不会调用 `locateFile`，
 * 「不可能走 CDN」是从机制上保证的，而不是靠一条容易在升级后失效的覆盖规则。
 * 仍然保留 `locateFile` 作为第二道保险，路径指回同一个本地资源。
 */
function prepare(): Promise<void> {
  prepared ??= (async () => {
    const bytes = await fetch(wasmUrl).then((r) => {
      if (!r.ok) throw new Error(`取本地 wasm 失败：${r.status} ${wasmUrl}`);
      return r.arrayBuffer();
    });
    prepareZXingModule({
      overrides: {
        wasmBinary: bytes,
        locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
      },
    });
  })();
  return prepared;
}

/** 相对页面的裁剪框 [x0, y0, x1, y1]，取值 0–1 */
type Region = readonly [number, number, number, number];

/**
 * 数电票的二维码固定在**票面左上角**。取左上 32% × 50% 足够盖住它，
 * 面积只有整页的 1/6，栅格化和 zxing 扫描都快很多。
 */
const TOP_LEFT: Region = [0, 0, 0.32, 0.5];
const WHOLE: Region = [0, 0, 1, 1];

/**
 * 只把 PDF 第 1 页的**指定区域**画成像素。
 *
 * 关键在 pdfjs 的 `transform` 参数：画布只开区域那么大，再用 `[-x*s, -y*s]`
 * 把区域左上角挪到原点、整体放大 s 倍 —— 于是渲染量按区域面积缩小，
 * 而不是先把整页画出来再裁。这套参数由内核 `regionRenderArgs()` 算
 * （viewport 必须传 `scale: 1`，缩放只写在 transform 里，否则会被平方），
 * 这里只递一个**相对**区域，具体几何交给渲染引擎。
 */
async function rasterizeRegion(
  bytes: Uint8Array,
  region: Region,
  scale: number,
): Promise<ImageData | undefined> {
  const result = await renderPage(bytes, {
    kind: 'pdf',
    pageIndex: 0,
    boxFrac: region,
    scale,
    encode: null,
  }).catch(() => undefined);
  return result ? resultPixels(result) : undefined;
}

async function scan(image: ImageData): Promise<string | undefined> {
  const results = await readBarcodes(image, {
    formats: ['QRCode'],
    tryHarder: true,
  });
  const hit = results.find((r) => r.isValid && r.text);
  return hit?.text;
}

/**
 * PDF 字节 → 二维码原文。
 *
 * 先用左上角小图快速命中（真实数电票走这条）；命不中再退化成整页扫描
 * （竖版票、二维码位置不同的票种都能兜住）。
 * 小图用更高倍率（4×）是因为区域小、代价低，而 QR 模块多、需要足够像素。
 */
export async function decodeQrFromPdf(bytes: Uint8Array): Promise<string | undefined> {
  await prepare();

  const corner = await rasterizeRegion(bytes, TOP_LEFT, 4);
  if (corner) {
    const hit = await scan(corner).catch(() => undefined);
    if (hit) return hit;
  }

  const whole = await rasterizeRegion(bytes, WHOLE, 2.5);
  if (!whole) return undefined;
  return scan(whole).catch(() => undefined);
}

/** 图片文件（png/jpg）→ 二维码原文。zxing 自己会解码图片，不用 canvas。 */
export async function decodeQrFromImage(bytes: Uint8Array, mime: string): Promise<string | undefined> {
  await prepare();
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const results = await readBarcodes(blob, {
    formats: ['QRCode'],
    tryHarder: true,
  });
  const hit = results.find((r) => r.isValid && r.text);
  return hit?.text;
}
