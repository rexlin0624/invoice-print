import type { Invoice, InvoiceKind } from '@invoice-tool/core';
import { INVOICE_KIND_LABEL, formatCents } from '@invoice-tool/core';

export { formatCents };

export function money(cents: number | undefined): string {
  return cents === undefined ? '—' : formatCents(cents);
}

export function kindLabel(kind: InvoiceKind): string {
  return INVOICE_KIND_LABEL[kind];
}

/** 票种 chip 的配色类：普票蓝、专票绿、火车票/行程单橙 */
export function kindChipClass(kind: InvoiceKind): string {
  if (kind === 'vat-special') return 'chip chip-special';
  if (kind === 'vat-general') return 'chip chip-general';
  if (kind === 'train' || kind === 'air' || kind === 'taxi' || kind === 'ride') return 'chip chip-ticket';
  return 'chip';
}

export function fileNameTail(name: string, max = 40): string {
  return name.length <= max ? name : `…${name.slice(-max)}`;
}

/** 人看的体积：B / KB / MB */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function summarize(inv: Invoice): string {
  const bits = [inv.sellerName ?? '未识别销售方'];
  if (inv.invoiceNo) bits.push(inv.invoiceNo);
  return bits.join(' · ');
}

/** 列表里显示金额：优先价税合计，其次「不含税 + 税额」 */
export function displayTotal(inv: Invoice): number | undefined {
  if (inv.total !== undefined) return inv.total;
  if (inv.amount !== undefined && inv.tax !== undefined) return inv.amount + inv.tax;
  return undefined;
}
