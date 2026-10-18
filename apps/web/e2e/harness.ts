/**
 * 真实浏览器里的渲染回归（e2e）。
 *
 * 为什么不能只靠 `pnpm test`：内核单测跑在 Node 里，而**渲染是浏览器能力** ——
 * pdfjs 的 worker、`OffscreenCanvas`、`canvas.getImageData`、zxing 的 wasm
 * 在 Node 里一个都没有。这个仓库历史上最贵的一次事故就是这个落差：
 * 「单测全绿、网页里全空」（见 `pdfjsSafe.ts`）。
 *
 * 这个文件由 `scripts/e2e.mjs` 用无头 Chrome 打开：跑完把所有结果 POST 给
 * 一个本地小服务器（脚本起的），再打印成人能读的表格。
 * `apps/web/e2e/` 与 `scripts/e2e.mjs` 都**不进产物**（没有别处 import 它们）。
 *
 * 用 pdf-lib 现场生成夹具，而不是读 `samples/private/`：
 * 真实发票是个人数据，e2e 不该依赖它；而且几何自造的夹具才能断言**像素级**结论
 * （比如「这个矩形应该正好画在这个位置」）。有真样本时另外加一条非致命的验证。
 */

import { PDFDocument, rgb } from 'pdf-lib';

import { detectContentBox, imageSize, rasterizeImage, rasterizePage } from '../src/lib/raster';
import { renderEngineInUse, renderPage, resultBytes, resultPixels } from '../src/lib/render/client';
import { decodeQrFromPdf } from '../src/lib/qr';
import { thumbnailFor } from '../src/lib/thumb';

/** 夹具页尺寸（pt），特意不是 A4，免得「恰好相等」掩盖单位错误 */
const PAGE = { width: 400, height: 300 };
/** 小黑块：左上原点 (100, 200)，40×20 pt */
const BLOCK = { x: 100, y: 200, w: 40, h: 20 };
/** 大白边用的大黑块：左上原点 (50, 50)，300×200 pt（覆盖率 ~50%，够判「值得裁」） */
const BIG = { x: 50, y: 50, w: 300, h: 200 };

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

/** 局部超时：主线程那条路在隐藏标签页里可能永远回不来，别把整轮 e2e 拖死 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超过 ${ms} ms 没回来`)), ms),
    ),
  ]);
}

function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

/** pdf-lib 用「左下原点、y 向上」，我们的坐标系是「左上原点、y 向下」，这里换算 */
function flipY(top: number, height: number): number {
  return PAGE.height - top - height;
}

async function fixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([PAGE.width, PAGE.height]);
  first.drawRectangle({
    x: BLOCK.x,
    y: flipY(BLOCK.y, BLOCK.h),
    width: BLOCK.w,
    height: BLOCK.h,
    color: rgb(0, 0, 0),
  });

  // 第 2 页：一个大黑块，用来验「白边探测」与多页
  const second = pdf.addPage([PAGE.width, PAGE.height]);
  second.drawRectangle({
    x: BIG.x,
    y: flipY(BIG.y, BIG.h),
    width: BIG.w,
    height: BIG.h,
    color: rgb(0, 0, 0),
  });

  return pdf.save();
}

/** 某个像素是不是黑的（RGBA） */
function isDark(pixels: Uint8ClampedArray, width: number, x: number, y: number): boolean {
  const at = (y * width + x) * 4;
  return pixels[at]! < 64 && pixels[at + 1]! < 64 && pixels[at + 2]! < 64;
}

/** 暗像素占比（判断「这一页不是空白」用） */
function inkRatio(pixels: Uint8ClampedArray): number {
  let dark = 0;
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at]! < 200 || pixels[at + 1]! < 200 || pixels[at + 2]! < 200) dark++;
  }
  return dark / (pixels.length / 4);
}

async function main(): Promise<void> {
  const pdf = await fixture();
  const pdfBuffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;

  // —— 1. 尺寸：probe 不画，只量 ——
  const probed = await renderPage(pdf, {
    kind: 'pdf',
    pageIndex: 0,
    probe: true,
  });
  check(
    'probe 量到页尺寸',
    near(probed.base.width, PAGE.width, 0.01) && near(probed.base.height, PAGE.height, 0.01),
    `${probed.base.width.toFixed(1)}×${probed.base.height.toFixed(1)} pt（期望 ${PAGE.width}×${PAGE.height}）`,
  );

  // —— 2. 区域渲染 + 坐标系（**最关键的一条**）——
  // 故意渲染一块**比黑块四周各多 10 pt** 的区域：这样画布上黑块该落在 (10,10)-(50,30)，
  // 里外各取几个点就能同时钉住「缩放」与「位移」。
  // 如果缩放被平方（regionRenderArgs 文件头那个经典坑），或者 y 轴方向搞反，这里必然对不上。
  const MARGIN = 10;
  const frame = {
    x: BLOCK.x - MARGIN,
    y: BLOCK.y - MARGIN,
    w: BLOCK.w + MARGIN * 2,
    h: BLOCK.h + MARGIN * 2,
  };
  const corner = await renderPage(pdf, {
    kind: 'pdf',
    pageIndex: 0,
    box: frame,
    scale: 1,
    encode: null,
  });
  const cornerPixels = resultPixels(corner).data;
  const darkAt = (x: number, y: number) => isDark(cornerPixels, corner.width, x, y);
  check(
    'worker：区域渲染的尺寸与像素',
    corner.width === frame.w &&
      corner.height === frame.h &&
      darkAt(MARGIN + 2, MARGIN + 2) &&
      darkAt(MARGIN + BLOCK.w - 2, MARGIN + BLOCK.h - 2) &&
      !darkAt(MARGIN - 3, MARGIN - 3) &&
      !darkAt(MARGIN + BLOCK.w + 2, MARGIN + BLOCK.h + 2),
    `画布 ${corner.width}×${corner.height}（期望 ${frame.w}×${frame.h}），黑块内/外=(${darkAt(MARGIN + 2, MARGIN + 2) ? '黑' : '白'}/${darkAt(MARGIN - 3, MARGIN - 3) ? '黑' : '白'})，黑块右下内/外=(${darkAt(MARGIN + BLOCK.w - 2, MARGIN + BLOCK.h - 2) ? '黑' : '白'}/${darkAt(MARGIN + BLOCK.w + 2, MARGIN + BLOCK.h + 2) ? '黑' : '白'})`,
  );

  // —— 3. 高倍率：同一个区域放大 3 倍 ——
  const zoomed = await renderPage(pdf, {
    kind: 'pdf',
    pageIndex: 0,
    box: { ...BLOCK },
    scale: 3,
    encode: null,
  });
  const zoomedPixels = resultPixels(zoomed).data;
  check(
    'worker：3× 放大后尺寸与内容',
    zoomed.width === BLOCK.w * 3 &&
      zoomed.height === BLOCK.h * 3 &&
      isDark(zoomedPixels, zoomed.width, Math.floor(zoomed.width / 2), Math.floor(zoomed.height / 2)),
    `画布 ${zoomed.width}×${zoomed.height}（期望 ${BLOCK.w * 3}×${BLOCK.h * 3}），scale=${zoomed.scale}`,
  );

  // —— 4. 主线程兜底那条路：同样的区域，同样的结论 ——
  (globalThis as { __invoiceRenderEngine?: string }).__invoiceRenderEngine = 'main';
  let mainDetail = '';
  let mainOk = false;
  try {
    const mainCorner = await withTimeout(
      renderPage(pdf, {
        kind: 'pdf',
        pageIndex: 0,
        box: { ...BLOCK },
        scale: 1,
        encode: null,
      }),
      20_000,
      '主线程渲染',
    );
    const mainPixels = resultPixels(mainCorner).data;
    mainOk =
      mainCorner.width === BLOCK.w &&
      mainCorner.height === BLOCK.h &&
      isDark(
        mainPixels,
        mainCorner.width,
        Math.floor(mainCorner.width / 2),
        Math.floor(mainCorner.height / 2),
      );
    mainDetail = `画布 ${mainCorner.width}×${mainCorner.height}，与 Worker 那条路一致=${mainOk}`;
  } catch (err) {
    mainDetail = `失败/超时：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    delete (globalThis as { __invoiceRenderEngine?: string }).__invoiceRenderEngine;
  }
  check('主线程兜底：同样的区域渲染', mainOk, mainDetail);

  // —— 5. 白边探测：内容边界要落在那个大黑块附近（pad 4pt）——
  const inkBox = await detectContentBox(pdf, 1);
  check(
    '白边探测的边界',
    inkBox !== undefined &&
      near(inkBox.x, BIG.x - 4, 3) &&
      near(inkBox.y, BIG.y - 4, 3) &&
      near(inkBox.w, BIG.w + 8, 6) &&
      near(inkBox.h, BIG.h + 8, 6),
    inkBox
      ? `x=${inkBox.x.toFixed(1)} y=${inkBox.y.toFixed(1)} w=${inkBox.w.toFixed(1)} h=${inkBox.h.toFixed(1)}（期望 ≈ ${BIG.x - 4},${BIG.y - 4},${BIG.w + 8},${BIG.h + 8}）`
      : '没探测到内容',
  );

  // —— 6. 黑白栅格化：PNG 出来之后再当图片读回来，像素只能是 0 / 255 ——
  const blackWhite = await rasterizePage(pdf, 1, { blackWhite: true, dpi: 72 });
  let bwDetail = '没渲染出图片';
  let bwOk = false;
  if (blackWhite && blackWhite.mime === 'image/png') {
    const back = await renderPage(blackWhite.bytes, {
      kind: 'image',
      scale: 1,
      encode: null,
    });
    const px = resultPixels(back).data;
    let onlyExtremes = true;
    for (let at = 0; at < px.length; at += 4) {
      const v = px[at]!;
      if (v !== 0 && v !== 255) {
        onlyExtremes = false;
        break;
      }
    }
    // 黑白栅格是**整页** 72 dpi，所以像素尺寸就是页面的 pt 尺寸
    bwOk =
      onlyExtremes && px.length > 0 && near(back.width, PAGE.width, 1) && near(back.height, PAGE.height, 1);
    bwDetail = `PNG ${blackWhite.bytes.byteLength} B，读回 ${back.width}×${back.height}（期望 ${PAGE.width}×${PAGE.height}），只含 0/255=${onlyExtremes}`;
  }
  check('黑白栅格化（PNG）+ 图片路径读回', bwOk, bwDetail);

  // —— 7. 图片尺寸（probe 那条路）——
  const png = await renderPage(pdf, {
    kind: 'pdf',
    pageIndex: 0,
    scale: 2,
    encode: 'image/png',
  });
  const size = await imageSize(resultBytes(png));
  check(
    'imageSize 量图片像素',
    size !== undefined && size.width === png.width && size.height === png.height,
    size ? `${size.width}×${size.height}（期望 ${png.width}×${png.height}）` : '量不到',
  );

  // —— 7b. 图片栅格化：不传 dpi 时必须保持 1:1（打印排版按 pt 摆图，放大/缩小都会错位）——
  const imageRaster = await rasterizeImage(resultBytes(png));
  check(
    '图片栅格化保持 1:1',
    imageRaster !== undefined &&
      near(imageRaster.widthPt, png.width, 1) &&
      near(imageRaster.heightPt, png.height, 1) &&
      imageRaster.mime === 'image/jpeg',
    imageRaster
      ? `${imageRaster.mime} ${imageRaster.bytes.byteLength} B，${imageRaster.widthPt}×${imageRaster.heightPt} pt（期望 ${png.width}×${png.height}）`
      : '没出图',
  );

  // —— 8. 缩略图：dataURL 契约与内容 ——
  const thumb = await thumbnailFor('e2e', pdf, 400, 0);
  check(
    '缩略图 dataURL',
    typeof thumb === 'string' && thumb.startsWith('data:image/jpeg;base64,') && thumb.length > 1000,
    thumb ? `${thumb.slice(0, 32)}… 共 ${thumb.length} 字符` : '没出图',
  );

  // —— 9. 二维码那条路：没有二维码时要**安静地返回 undefined**，且不许出网 ——
  let qrDetail = '';
  let qrOk = false;
  try {
    const decoded = await withTimeout(decodeQrFromPdf(pdf), 30_000, '二维码解码');
    const external = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /jsdelivr|unpkg|cdn\./i.test(name));
    qrOk = decoded === undefined && external.length === 0;
    qrDetail = `结果=${decoded === undefined ? 'undefined（符合预期）' : '意外命中'}，外部请求 ${
      external.length === 0 ? '0 个' : external.join(', ')
    }`;
  } catch (err) {
    qrDetail = `抛异常：${err instanceof Error ? err.message : String(err)}`;
  }
  check('无二维码的票不抛异常 + 零外部请求', qrOk, qrDetail);

  // —— 10. 真样本（有才跑）：证明真实票面在 Worker 里画得出来 ——
  try {
    const listed = await fetch('/__samples__/index.json').then((r) => (r.ok ? r.json() : null));
    const first = (listed?.files ?? []) as string[];
    const target = first.find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!target) {
      check('真样本渲染（可选）', true, 'samples/private 里没有 PDF，跳过');
    } else {
      const response = await fetch(`/__samples__/${encodeURIComponent(target)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const shot = await renderPage(bytes, {
        kind: 'pdf',
        pageIndex: 0,
        dpi: 72,
        encode: null,
      });
      const ratio = inkRatio(resultPixels(shot).data);
      check(
        '真样本渲染（可选）',
        ratio > 0.001,
        `${target}：${shot.width}×${shot.height}，着墨像素 ${(ratio * 100).toFixed(2)}%`,
      );
    }
  } catch (err) {
    check('真样本渲染（可选）', true, `跳过（${err instanceof Error ? err.message : String(err)}）`);
  }

  // —— 11. 渲染时主线程还被让得出来（信息项）——
  const gaps: number[] = [];
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last - 20);
    last = now;
  }, 20);
  await Promise.all(
    [0, 1, 0].map((page) => renderPage(pdf, { kind: 'pdf', pageIndex: page, dpi: 200, encode: null })),
  );
  clearInterval(ticker);
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;
  check(
    '渲染时主线程的停顿',
    maxGap < 2000,
    `3 页@200dpi，主线程最长停顿 ${maxGap.toFixed(0)} ms（信息项，仅防「整段卡死」）`,
  );

  void pdfBuffer;
}

async function report(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const endpoint = params.get('report');
  const payload = {
    engine: renderEngineInUse(),
    visibility: document.visibilityState,
    hidden: document.hidden,
    ok: results.every((r) => r.ok),
    results,
  };
  const log = document.getElementById('log');
  if (log) log.textContent = JSON.stringify(payload, null, 2);
  if (!endpoint) return;
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

try {
  await main();
} catch (err) {
  check('harness 自身', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
}
await report();
