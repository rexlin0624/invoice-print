/**
 * 票面信息卡。
 *
 * XML / OFD 票没有可嵌入的 PDF 页面，但也不能让它们在纸上变成空白。
 * 这里用 canvas 画一张卡片再当图片嵌进 PDF —— 顺带解决了 pdf-lib 标准字体
 * **渲染不了中文**的问题（标准字体是 WinAnsi 编码）。
 *
 * ⚠️ 这是**降级产物**，不是票面。卡片顶部必须有一条醒目的警示条，
 * 而且字号要有**物理下限**：A4 四宫格下槽位只有约 297 × 210 pt，
 * 按「以 595pt 宽为基准等比缩放」排出来的字最小只有 5pt，纸上根本看不清 ——
 * 那一行的全部意义就是「让人看见」，看不见等于没写。
 */

import type { Invoice } from '@invoice-tool/core';
import { INVOICE_KIND_LABEL, invoiceTotal, isRedInvoice } from '@invoice-tool/core';

import { money } from './format';

const PX_PER_PT = 3;

/** 纸上必须看得清的字号下限（pt）。比这更小的中文在打印件上等于没写。 */
const MIN_LEGIBLE_PT = 9;

export interface RenderedCard {
  /** PNG 字节 */
  png: Uint8Array;
  widthPt: number;
  heightPt: number;
}

export async function renderInvoiceCard(
  inv: Invoice,
  widthPt: number,
  heightPt: number,
): Promise<RenderedCard> {
  const w = Math.max(240, Math.round(widthPt * PX_PER_PT));
  const h = Math.max(160, Math.round(heightPt * PX_PER_PT));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布');

  const s = w / 595; // 以「一张 595pt 宽的票」为基准做等比排版
  const px = (v: number): number => v * s;
  /**
   * 等比缩放**但保底**：小槽位下不低于 `MIN_LEGIBLE_PT`。
   * canvas 的 px/pt 恒为 `PX_PER_PT`（因为 `w = widthPt * PX_PER_PT`），
   * 所以「物理上 N pt」就是 `N * PX_PER_PT` 像素，与槽位大小无关。
   */
  const pxFloor = (v: number, minPt = MIN_LEGIBLE_PT): number =>
    Math.max(px(v), minPt * PX_PER_PT);

  // 底
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#c9ced8';
  ctx.lineWidth = Math.max(1, px(1.4));
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);

  // ---- 顶部警示条：这张纸不是票面 ----
  // 解析失败的票更要说清：那种卡片上连金额都没有，贴进报销单会被打回来。
  const broken = inv.issues.find((issue) => issue.level === 'error');
  const barH = Math.max(px(30), 15 * PX_PER_PT);
  ctx.fillStyle = broken ? '#dc2626' : '#f59e0b';
  ctx.fillRect(0, 0, w, barH);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${pxFloor(15, 10)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  const barText = broken ? '信息卡 · 原文件解析失败' : '信息卡 · 非票面原样';
  ctx.fillText(barText, px(18), barH / 2);

  // 文件名放警示条右侧：报销对账时第一件事就是「这张对应哪个文件」
  ctx.textAlign = 'right';
  ctx.fillStyle = broken ? '#ffe4e6' : '#fffbeb';
  ctx.font = `400 ${pxFloor(12)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.fillText(clip(ctx, inv.fileName, w / 2 - px(24)), w - px(18), barH / 2);
  ctx.textAlign = 'left';

  // 顶部：票种 + 特定业务（红冲要写在卡片上，否则打印出来的纸和正常票长得一样）
  const top = barH;
  const red = isRedInvoice(inv) ? ' · 红冲' : '';
  const tag = INVOICE_KIND_LABEL[inv.kind] + (inv.businessTag ? ` · ${inv.businessTag}` : '') + red;
  ctx.fillStyle = '#1d4ed8';
  ctx.fillRect(px(18), top + px(16), px(4), px(22));
  ctx.fillStyle = '#111827';
  ctx.font = `700 ${px(20)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(tag, px(30), top + px(28));

  const right = (text: string, y: number): void => {
    ctx.textAlign = 'right';
    ctx.fillText(text, w - px(18), y);
    ctx.textAlign = 'left';
  };

  ctx.fillStyle = '#6b7280';
  ctx.font = `400 ${px(12)}px -apple-system, "PingFang SC", sans-serif`;
  right(`发票号码 ${inv.invoiceNo ?? '未识别'}`, top + px(28));

  // 中部大金额
  const total = invoiceTotal(inv);
  ctx.fillStyle = '#111827';
  ctx.font = `700 ${px(30)}px -apple-system, "PingFang SC", sans-serif`;
  ctx.fillText(
    total === undefined ? '价税合计 未识别' : `价税合计 ${money(total)}`,
    px(18),
    top + px(76),
  );

  if (inv.totalInWords !== undefined) {
    ctx.fillStyle = '#6b7280';
    ctx.font = `400 ${px(12)}px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(inv.totalInWords, px(18), top + px(100));
  }

  // 明细行
  const rows: Array<[string, string]> = [
    ['销售方', inv.sellerName ?? '未识别'],
    ['购买方', inv.buyerName ?? '未识别'],
    ['开票日期', inv.issueDate ?? '未识别'],
    ['不含税 / 税额', `${money(inv.amount)} / ${money(inv.tax)}`],
    ['文件', inv.fileName],
  ];

  ctx.font = `400 ${px(13)}px -apple-system, "PingFang SC", sans-serif`;
  let y = top + px(126);
  for (const [label, value] of rows) {
    ctx.fillStyle = '#9aa2ae';
    ctx.fillText(label, px(18), y);
    ctx.fillStyle = '#374151';
    ctx.fillText(clip(ctx, value, w - px(140)), px(120), y);
    y += px(20);
  }

  // 解析失败原因（卡片上唯一能说明「为什么这张是空的」的地方）
  if (broken) {
    ctx.fillStyle = '#b91c1c';
    ctx.font = `400 ${pxFloor(11)}px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(clip(ctx, broken.message, w - px(36)), px(18), y + px(6));
    y += px(20);
  }

  // 底部说明
  ctx.fillStyle = '#9aa2ae';
  ctx.font = `400 ${pxFloor(10.5, 8)}px -apple-system, "PingFang SC", sans-serif`;
  ctx.fillText(
    clip(ctx, '本页由「发票工具」根据 XML/OFD 结构化数据生成，不是票面原样', w - px(36)),
    px(18),
    h - px(18),
  );

  const png = await canvasToPng(canvas);
  return { png, widthPt, heightPt };
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('画布转 PNG 失败'));
        return;
      }
      void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, 'image/png');
  });
}
