/**
 * 合成打印 PDF。
 *
 * 输入是内核输出的 `LayoutSpec`（唯一一份几何，单位 pt，y 轴向下），
 * 这里是**薄适配器**：只把 y 轴翻一次，不做任何排版计算。
 * 排版算两套是参考项目的坑，不要再犯。
 *
 * 三条嵌入路径：
 * 1. **矢量直通**（默认）—— 源 PDF 页原样嵌入，清晰度无损
 * 2. **矢量 + 裁剪**（开了「裁掉白边」）—— 用 PDF 的裁剪路径只露出内容区，
 *    仍然是矢量，不降清晰度
 * 3. **栅格**（黑白打印 / 老打印机兼容 / 图片票）—— 先渲染成像素再嵌
 */

import type { Invoice, LayoutSpec, Slot } from '@invoice-tool/core';
import { guardFormula, guardLongDigits, INVOICE_KIND_LABEL } from '@invoice-tool/core';
import type { PDFPage } from 'pdf-lib';
import {
  PDFDocument,
  StandardFonts,
  closePath,
  clip,
  degrees,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';

import { renderInvoiceCard } from './card';
import type { IntakeItem } from './intake';
import { sourcePage } from './pages';
import { rasterizeImage, rasterizePage } from './raster';
import { isDesktop, logLine, printDocument } from './shell';

export interface ComposeOptions {
  cutLines: boolean;
  pageNumbers: boolean;
  /** 老打印机兼容：整页栅格化，重建成「纯图片 PDF」 */
  rasterCompat: boolean;
  /** 黑白打印：栅格化 + 阈值化 */
  blackWhite: boolean;
  /** 栅格化分辨率，默认 200 */
  dpi?: number;
  /** 逐步进度（栅格化比较慢，需要给用户反馈） */
  onProgress?: (done: number, total: number) => void;
}

export interface ComposedPdf {
  bytes: Uint8Array;
  pageCount: number;
}

type Card = { png: Uint8Array; widthPt: number; heightPt: number };

/** 已渲染过的信息卡按「id@尺寸」缓存，避免同一张票多页重复画 */
const cardCache = new Map<string, Promise<Card>>();

function cardFor(item: IntakeItem, slot: Slot): Promise<Card> {
  const key = `${item.id}@${Math.round(slot.contentW)}x${Math.round(slot.contentH)}`;
  const hit = cardCache.get(key);
  if (hit) return hit;
  const task = renderInvoiceCard(item.invoice, slot.contentW, slot.contentH);
  cardCache.set(key, task);
  return task;
}

/** 内核 y 向下 → PDF y 向上（唯一的坐标系翻转点） */
function flipY(pageHeight: number, slotY: number, slotH: number): number {
  return pageHeight - (slotY + slotH);
}

/**
 * 把源 PDF 的某一页铺进槽位（矢量）。
 *
 * 旋转 90° 的推导：pdf-lib 的 rotate 是绕 (x, y) 逆时针旋转；内容本地占 (w,h)，
 * 旋转后包围盒是 x∈[-h,0]、y∈[0,w]。要让它落在 x∈[L,L+h]、y∈[B,B+w]，
 * 原点要放在 (L+h, B)，并传**未旋转**的 (w,h)。
 *
 * 裁剪的推导（只在 `box` 存在时走）：先把**整页**按 `s` 缩放到槽位内容区，
 * 再让源页面的 (box.x, box.y) 正好落在内容区左上角，最后用裁剪路径只露出内容区。
 * 这样「裁掉白边」仍然是矢量的，不必栅格化。
 */
async function drawEmbedded(
  out: PDFDocument,
  page: PDFPage,
  source: Uint8Array,
  pageIndex: number,
  slot: Slot,
  pageHeight: number,
  srcWidth: number,
  srcHeight: number,
  box?: { x: number; y: number; w: number; h: number },
): Promise<boolean> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    // 嵌不进去就退回信息卡（卡片是 canvas 画的，一定能出图）
    console.warn('[print] 内嵌源页面失败，改用信息卡：', err);
    return false;
  }

  const first = src.getPages()[pageIndex] ?? src.getPages()[0];
  if (!first) {
    console.warn('[print] 源 PDF 没有页面');
    return false;
  }

  const embedded = await out.embedPage(first);
  const bottom = flipY(pageHeight, slot.contentY, slot.contentH);

  if (box) {
    const s = slot.contentW / box.w;
    const left = slot.contentX;
    const top = pageHeight - slot.contentY;
    const clipBottom = bottom;

    page.pushOperators(
      pushGraphicsState(),
      moveTo(left, clipBottom),
      lineTo(left + slot.contentW, clipBottom),
      lineTo(left + slot.contentW, clipBottom + slot.contentH),
      lineTo(left, clipBottom + slot.contentH),
      closePath(),
      clip(),
      endPath(),
    );
    page.drawPage(embedded, {
      x: left - box.x * s,
      y: top - (srcHeight - box.y) * s,
      width: srcWidth * s,
      height: srcHeight * s,
    });
    page.pushOperators(popGraphicsState());
    return true;
  }

  if (slot.rotation === 90) {
    page.drawPage(embedded, {
      x: slot.contentX + slot.contentW,
      y: bottom,
      width: srcWidth * slot.scale,
      height: srcHeight * slot.scale,
      rotate: degrees(90),
    });
  } else {
    page.drawPage(embedded, {
      x: slot.contentX,
      y: bottom,
      width: slot.contentW,
      height: slot.contentH,
    });
  }

  return true;
}

/** 栅格化一张票的某一页，并按槽位画上去 */
async function drawRaster(
  out: PDFDocument,
  page: PDFPage,
  item: IntakeItem,
  slot: Slot,
  pageHeight: number,
  options: ComposeOptions,
): Promise<boolean> {
  const pageIndex = sourcePage(item, slot.page);
  const box = item.crop ?? undefined;
  const raster =
    item.visual === 'image'
      ? await rasterizeImage(item.data, { blackWhite: options.blackWhite, ...(box ? { box } : {}) })
      : await rasterizePage(item.data, pageIndex, {
          dpi: options.dpi ?? 200,
          blackWhite: options.blackWhite,
          ...(box ? { box } : {}),
        });
  if (!raster) return false;

  const image =
    raster.mime === 'image/png' ? await out.embedPng(raster.bytes) : await out.embedJpg(raster.bytes);
  page.drawImage(image, {
    x: slot.contentX,
    y: flipY(pageHeight, slot.contentY, slot.contentH),
    width: slot.contentW,
    height: slot.contentH,
  });
  return true;
}

export async function composePrintPdf(
  items: readonly IntakeItem[],
  spec: LayoutSpec,
  options: ComposeOptions,
): Promise<ComposedPdf> {
  const out = await PDFDocument.create();
  out.setProducer('发票工具');
  out.setCreator('发票工具');

  const byId = new Map(items.map((it) => [it.id, it]));
  const font = await out.embedFont(StandardFonts.Helvetica);

  const slots = spec.pages.reduce((n, p) => n + p.slots.length, 0);
  let done = 0;
  // 同一个源页在多页票里只出现一次，但槽位可能重复引用（理论上不会），这里按张计数
  const rasterizeAll = options.rasterCompat || options.blackWhite;

  for (const pageSpec of spec.pages) {
    const page = out.addPage([pageSpec.width, pageSpec.height]);

    for (const slot of pageSpec.slots) {
      const item = byId.get(slot.id);
      if (!item) continue;

      let drawn = false;
      if (item.embeddable && item.data.byteLength > 0) {
        if (item.visual === 'image' || rasterizeAll) {
          drawn = await drawRaster(out, page, item, slot, pageSpec.height, options);
        } else {
          drawn = await drawEmbedded(
            out,
            page,
            item.data,
            sourcePage(item, slot.page),
            slot,
            pageSpec.height,
            item.width,
            item.height,
            item.crop ?? undefined,
          );
        }
        done += 1;
        options.onProgress?.(done, slots);
      }

      if (!drawn) {
        const card = await cardFor(item, slot);
        const png = await out.embedPng(card.png);
        page.drawImage(png, {
          x: slot.contentX,
          y: flipY(pageSpec.height, slot.contentY, slot.contentH),
          width: slot.contentW,
          height: slot.contentH,
        });
      }

      if (options.cutLines) {
        page.drawRectangle({
          x: slot.x,
          y: flipY(pageSpec.height, slot.y, slot.h),
          width: slot.w,
          height: slot.h,
          borderColor: rgb(0.72, 0.75, 0.79),
          borderWidth: 0.5,
          borderDashArray: [3, 3],
        });
      }
    }

    if (options.pageNumbers) {
      const label = `${pageSpec.index + 1} / ${spec.pageCount}`;
      page.drawText(label, {
        x: (pageSpec.width - font.widthOfTextAtSize(label, 9)) / 2,
        y: 18,
        size: 9,
        font,
        color: rgb(0.55, 0.58, 0.62),
      });
    }
  }

  const bytes = await out.save();
  return { bytes, pageCount: spec.pageCount };
}

/**
 * 打印。两条路：
 * - **桌面版**：字节交给 Rust 写临时文件再交给系统（macOS/Linux `lp`，Windows `-Verb Print`）。
 *   桌面端不能学网页版用隐藏 iframe：`window.print()` 打的是当前界面不是合成 PDF，
 *   而且 WKWebView / WebView2 里 iframe 根本渲染不了 PDF 流。
 * - **网页版**：隐藏 iframe 调系统打印对话框；不支持时退化成「新标签页打开 PDF，自己按 ⌘P」。
 */
export interface PrintResult {
  ok: boolean;
  /** 给用户看的一句话（成功时报出打印机名） */
  message: string;
  /** 桌面端才有：临时 PDF 的路径（失败时拿它「用系统程序打开」） */
  path?: string;
}

export async function printPdf(bytes: Uint8Array, fileName: string): Promise<PrintResult> {
  if (isDesktop()) {
    const outcome = await printDocument(bytes, fileName);
    logLine(`print ${outcome.ok ? 'ok' : 'failed'}: ${outcome.message}`);
    return { ok: outcome.ok, message: outcome.message, path: outcome.path };
  }
  printViaBrowser(bytes, fileName);
  return { ok: true, message: '已调起浏览器打印' };
}

function printViaBrowser(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', fileName);
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.src = url;

  let opened = false;
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      opened = true;
    } catch {
      opened = false;
    }
    window.setTimeout(() => {
      iframe.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };

  document.body.appendChild(iframe);

  // 4 秒内没成功调起对话框就退化
  window.setTimeout(() => {
    if (opened) return;
    iframe.remove();
    URL.revokeObjectURL(url);
    window.open(url, '_blank');
  }, 4000);
}

/** 导出清单 CSV（Excel 可直接打开；发票号码强制文本，避免变成科学计数法） */
export function invoicesToCsv(invoices: readonly Invoice[]): string {
  const header = [
    '文件名',
    '票种',
    '发票号码',
    '发票代码',
    '开票日期',
    '销售方',
    '销售方税号',
    '购买方',
    '购买方税号',
    '不含税金额',
    '税额',
    '价税合计',
    '价税合计(大写)',
  ];
  const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;

  /**
   * 所有**文本**单元格都先过 `guardFormula`：文件名、销售方、大写金额都来自**别人给的文件**，
   * 一句 `=HYPERLINK(...)` 就能在「导出 Excel」时变成执行入口。
   *
   * 然后再做长数字串保护（`="123…"`）—— 顺序不能反：
   * 先包成公式文本的话，`guardFormula` 就看不到前导危险字符了。
   */
  const text = (v: string): string => guardLongDigits(guardFormula(v));

  const yuan = (cents: number | undefined): string =>
    cents === undefined ? '' : (cents / 100).toFixed(2);

  /**
   * 金额列**不能**过 `guardFormula`：红字发票是负数，`-123.45` 会被加个前导单引号
   * 变成文本 `'-123.45`，Excel 里再也不能求和/排序。这列不是外部文本，
   * 是 `toFixed(2)` 拼出来的 `-?\d+\.\d{2}`，本身就没有公式注入的可能。
   */
  const money = (cents: number | undefined): string => esc(yuan(cents));

  const rows = invoices.map((inv) =>
    [
      esc(text(inv.fileName)),
      esc(text(INVOICE_KIND_LABEL[inv.kind] ?? inv.kind)),
      esc(text(inv.invoiceNo ?? '')),
      esc(text(inv.invoiceCode ?? '')),
      esc(text(inv.issueDate ?? '')),
      esc(text(inv.sellerName ?? '')),
      esc(text(inv.sellerTaxId ?? '')),
      esc(text(inv.buyerName ?? '')),
      esc(text(inv.buyerTaxId ?? '')),
      money(inv.amount),
      money(inv.tax),
      money(inv.total),
      esc(text(inv.totalInWords ?? '')),
    ].join(','),
  );

  return `\uFEFF${header.map((v) => esc(text(v))).join(',')}\n${rows.join('\n')}\n`;
}
