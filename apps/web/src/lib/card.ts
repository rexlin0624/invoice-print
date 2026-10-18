/**
 * 票面信息卡。
 *
 * XML / OFD 票没有可嵌入的 PDF 页面，但也不能让它们在纸上变成空白。
 * 这里用 canvas 画一张卡片再当图片嵌进 PDF —— 顺带解决了 pdf-lib 标准字体
 * **渲染不了中文**的问题（标准字体是 WinAnsi 编码）。
 */

import type { Invoice } from '@invoice-tool/core';
import { INVOICE_KIND_LABEL } from '@invoice-tool/core';

import { money } from './format';

const PX_PER_PT = 3;

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

  // 底
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#c9ced8';
  ctx.lineWidth = Math.max(1, px(1.4));
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);

  // 顶部：票种 + 特定业务
  const tag = INVOICE_KIND_LABEL[inv.kind] + (inv.businessTag ? ` · ${inv.businessTag}` : '');
  ctx.fillStyle = '#1d4ed8';
  ctx.fillRect(px(18), px(16), px(4), px(22));
  ctx.fillStyle = '#111827';
  ctx.font = `700 ${px(20)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(tag, px(30), px(28));

  const right = (text: string, y: number): void => {
    ctx.textAlign = 'right';
    ctx.fillText(text, w - px(18), y);
    ctx.textAlign = 'left';
  };

  ctx.fillStyle = '#6b7280';
  ctx.font = `400 ${px(12)}px -apple-system, "PingFang SC", sans-serif`;
  right(`发票号码 ${inv.invoiceNo ?? '未识别'}`, px(28));

  // 中部大金额
  const total = inv.total;
  ctx.fillStyle = '#111827';
  ctx.font = `700 ${px(30)}px -apple-system, "PingFang SC", sans-serif`;
  ctx.fillText(total === undefined ? '价税合计 未识别' : `价税合计 ${money(total)}`, px(18), px(76));

  if (inv.totalInWords !== undefined) {
    ctx.fillStyle = '#6b7280';
    ctx.font = `400 ${px(12)}px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(inv.totalInWords, px(18), px(100));
  }

  // 明细行
  const rows: Array<[string, string]> = [
    ['销售方', inv.sellerName ?? '未识别'],
    ['购买方', inv.buyerName ?? '未识别'],
    ['开票日期', inv.issueDate ?? '未识别'],
    ['不含税 / 税额', `${money(inv.amount)} / ${money(inv.tax)}`],
  ];

  ctx.font = `400 ${px(13)}px -apple-system, "PingFang SC", sans-serif`;
  let y = px(126);
  for (const [label, value] of rows) {
    ctx.fillStyle = '#9aa2ae';
    ctx.fillText(label, px(18), y);
    ctx.fillStyle = '#374151';
    ctx.fillText(clip(ctx, value, w - px(140)), px(120), y);
    y += px(20);
  }

  // 底部说明
  ctx.fillStyle = '#9aa2ae';
  ctx.font = `400 ${px(10.5)}px -apple-system, "PingFang SC", sans-serif`;
  ctx.fillText('本页由「发票工具」根据 XML/OFD 结构化数据生成，非票面原样', px(18), h - px(18));

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
