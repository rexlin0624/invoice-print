/**
 * 批次汇总：把一堆票折成「一眼能看完」的几个数。
 *
 * 为什么放在内核：汇总口径必须和打印、导出是同一份。
 * 早先只有列表底部一个「合计」，于是「有多少张没识别出号码」「哪个销售方占了多少」
 * 这类问题只能靠人肉数；而网页版和桌面版各写一遍汇总，迟早会对不上。
 *
 * 三条口径上的规矩：
 * 1. **金额缺失 ≠ 0 元**（`invoiceTotal`）。缺了就计数（`missingAmount`），
 *    绝不当 0 加进合计 —— 否则「漏了一张」看起来和「这张是 0 元」一模一样。
 * 2. 「已识别」= 有发票号码。号码是查重的钥匙，没有它这张票基本无法核对。
 * 3. 金额一律用整数「分」，只在 `summaryText` 里转成人看的「元」。
 */

import type { Cents } from '../model/money';
import { formatCents } from '../model/money';
import type { Invoice, InvoiceKind } from '../model/invoice';
import { INVOICE_KIND_LABEL, invoiceTotal } from '../model/invoice';

export interface KindBucket {
  kind: InvoiceKind;
  label: string;
  count: number;
  /** 该票种金额合计（分）。缺金额的票不计入，但计入 `count` */
  total: Cents;
}

export interface BatchSummary {
  /** 张数（每一张票算一张，多页票不重复计） */
  count: number;
  /** 有发票号码的张数 */
  recognized: number;
  missingNo: number;
  missingAmount: number;
  /** 金额合计（分，只统计拿得到金额的票） */
  amountTotal: Cents;
  /** 税额合计（分，只统计拿得到税额的票） */
  taxTotal: Cents;
  /** 按票种分组，张数多的在前 */
  byKind: KindBucket[];
  /** 不同销售方个数（未识别销售方的不计） */
  sellers: number;
  /** 开票日期范围（ISO），全都没日期时 undefined */
  dateFrom?: string;
  dateTo?: string;
}

/** 汇总一批票。**只看 `total/amount/tax` 与号码日期**，不碰任何 IO */
export function summarizeBatch(invoices: readonly Invoice[]): BatchSummary {
  const buckets = new Map<InvoiceKind, KindBucket>();
  const sellers = new Set<string>();
  let recognized = 0;
  let missingNo = 0;
  let missingAmount = 0;
  let amountTotal = 0;
  let taxTotal = 0;
  let dateFrom: string | undefined;
  let dateTo: string | undefined;

  for (const inv of invoices) {
    const total = invoiceTotal(inv);
    if (total === undefined) missingAmount += 1;
    else amountTotal += total;
    if (inv.tax !== undefined) taxTotal += inv.tax;

    if (inv.invoiceNo) recognized += 1;
    else missingNo += 1;

    if (inv.sellerName) sellers.add(inv.sellerName);

    if (inv.issueDate) {
      if (dateFrom === undefined || inv.issueDate < dateFrom) dateFrom = inv.issueDate;
      if (dateTo === undefined || inv.issueDate > dateTo) dateTo = inv.issueDate;
    }

    const bucket = buckets.get(inv.kind) ?? {
      kind: inv.kind,
      label: INVOICE_KIND_LABEL[inv.kind],
      count: 0,
      total: 0,
    };
    bucket.count += 1;
    if (total !== undefined) bucket.total += total;
    buckets.set(inv.kind, bucket);
  }

  return {
    count: invoices.length,
    recognized,
    missingNo,
    missingAmount,
    amountTotal,
    taxTotal,
    byKind: [...buckets.values()].sort((a, b) => b.count - a.count),
    sellers: sellers.size,
    ...(dateFrom !== undefined ? { dateFrom } : {}),
    ...(dateTo !== undefined ? { dateTo } : {}),
  };
}

/** 识别率（0–1）。空批次算 0，不返回 NaN —— 这个数会直接进界面 */
export function recognitionRate(summary: BatchSummary): number {
  return summary.count === 0 ? 0 : summary.recognized / summary.count;
}

/**
 * 汇总 → 一段可以贴进微信 / 邮件的纯文本。
 *
 * 为什么不给它逗号分隔：这段文字是给人看的（报销说明、群里对账），
 * 要公式的场合走 CSV / Excel，那边才有 `guardFormula` 那套保护。
 */
export function summaryText(summary: BatchSummary, options: { title?: string } = {}): string {
  const title = options.title ?? '发票汇总';
  const lines = [`${title}（${summary.count} 张）`];

  if (summary.count === 0) {
    lines.push('没有可统计的发票。');
    return lines.join('\n');
  }

  lines.push(`已识别发票号码：${summary.recognized} 张`);
  lines.push(`金额合计：${formatCents(summary.amountTotal)} 元`);
  if (summary.missingAmount > 0) lines.push(`（另有 ${summary.missingAmount} 张没识别到金额，未计入）`);
  if (summary.taxTotal > 0) lines.push(`其中税额：${formatCents(summary.taxTotal)} 元`);
  if (summary.dateFrom && summary.dateTo) {
    lines.push(
      summary.dateFrom === summary.dateTo
        ? `开票日期：${summary.dateFrom}`
        : `开票日期：${summary.dateFrom} ~ ${summary.dateTo}`,
    );
  }
  if (summary.sellers > 0) lines.push(`销售方：${summary.sellers} 家`);

  if (summary.byKind.length > 1 || (summary.byKind[0]?.count ?? 0) > 1) {
    const parts = summary.byKind.map((b) => `${b.label} ${b.count} 张（${formatCents(b.total)} 元）`);
    lines.push(`票种分布：${parts.join('；')}`);
  }

  if (summary.missingNo > 0) lines.push(`注意：${summary.missingNo} 张没有发票号码，建议先校正再报销。`);
  return lines.join('\n');
}
