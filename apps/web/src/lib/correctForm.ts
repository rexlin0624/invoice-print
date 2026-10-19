/**
 * 校正表单的**纯逻辑**：内核 `Invoice` ⇄ 界面表单，以及「表单 → 补丁」的差分。
 *
 * 为什么从组件里抽出来：这套规则（哪些字段改了、空串算清空、金额按分解析、
 * 明细整体替换、页码互补）是校正功能真正的合同，值得单测钉住；
 * 而组件里混着 JSX，测起来要么起 DOM、要么干脆没人测。
 *
 * 三条规矩，与内核的 `applyCorrection` 对齐：
 * 1. **只提交真的改过的字段** —— `provenance` 里的 `manual` 才是诚实的，
 *    用户没动过的字段不会被贴上「人工填写」，也就不会覆盖掉解析结果。
 * 2. **空 = 清空**（`null`），不是「保持原样」。
 * 3. 解析不了的金额**报错而不是当 0** —— 当 0 会把一张真票变成 0 元票，
 *    汇总时静默漏账。
 */

import type { CorrectPatch, Invoice, InvoiceItem, InvoiceKind } from '@invoice-tool/core';
import { centsToFixed, decimalToCents } from '@invoice-tool/core';

export interface ItemForm {
  name: string;
  spec: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxRate: string;
}

export interface CorrectForm {
  kind: InvoiceKind;
  invoiceNo: string;
  invoiceCode: string;
  issueDate: string;
  sellerName: string;
  sellerTaxId: string;
  buyerName: string;
  buyerTaxId: string;
  amount: string;
  tax: string;
  total: string;
  totalInWords: string;
  checkCode: string;
  items: ItemForm[];
  /** 勾上的页 = 要**打印**的页（与 `invoice.skipPages` 互补） */
  pages: number[];
}

/** 纯文本字段（金额单独处理） */
export const TEXT_FIELDS = [
  'invoiceNo',
  'invoiceCode',
  'issueDate',
  'sellerName',
  'sellerTaxId',
  'buyerName',
  'buyerTaxId',
  'totalInWords',
  'checkCode',
] as const;

export const MONEY_FIELDS = ['amount', 'tax', 'total'] as const;

const MONEY_LABEL: Record<(typeof MONEY_FIELDS)[number], string> = {
  amount: '不含税金额',
  tax: '税额',
  total: '价税合计',
};

/** 要打印的源页下标（0 基）。`skipPages` 说的正好相反 */
export function printPagesOf(inv: Invoice): number[] {
  const skip = new Set(inv.skipPages ?? []);
  return Array.from({ length: Math.max(1, inv.pageCount) }, (_, i) => i).filter((i) => !skip.has(i));
}

export function emptyRow(): ItemForm {
  return { name: '', spec: '', unit: '', quantity: '', unitPrice: '', amount: '', taxRate: '' };
}

export function itemToRow(it: InvoiceItem): ItemForm {
  return {
    name: it.name ?? '',
    spec: it.spec ?? '',
    unit: it.unit ?? '',
    quantity: it.quantity === undefined ? '' : String(it.quantity),
    unitPrice: it.unitPrice === undefined ? '' : centsToFixed(it.unitPrice),
    amount: it.amount === undefined ? '' : centsToFixed(it.amount),
    taxRate: it.taxRate ?? '',
  };
}

export function toForm(inv: Invoice): CorrectForm {
  return {
    kind: inv.kind,
    invoiceNo: inv.invoiceNo ?? '',
    invoiceCode: inv.invoiceCode ?? '',
    issueDate: inv.issueDate ?? '',
    sellerName: inv.sellerName ?? '',
    sellerTaxId: inv.sellerTaxId ?? '',
    buyerName: inv.buyerName ?? '',
    buyerTaxId: inv.buyerTaxId ?? '',
    amount: inv.amount === undefined ? '' : centsToFixed(inv.amount),
    tax: inv.tax === undefined ? '' : centsToFixed(inv.tax),
    total: inv.total === undefined ? '' : centsToFixed(inv.total),
    totalInWords: inv.totalInWords ?? '',
    checkCode: inv.checkCode ?? '',
    items: inv.items.map(itemToRow),
    pages: printPagesOf(inv),
  };
}

function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function num(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** 明细行 → 内核结构。空字段一律 `undefined`，不用空串冒充 */
export function parseRow(row: ItemForm, label: string): { item: InvoiceItem; errors: string[] } {
  const item: InvoiceItem = {};
  const errors: string[] = [];

  const name = text(row.name);
  if (name) item.name = name;
  const spec = text(row.spec);
  if (spec) item.spec = spec;
  const unit = text(row.unit);
  if (unit) item.unit = unit;

  const quantity = num(row.quantity);
  if (quantity !== null) {
    if (!Number.isFinite(quantity)) errors.push(`${label}的数量「${row.quantity}」不是数字`);
    else item.quantity = quantity;
  }

  for (const field of ['unitPrice', 'amount'] as const) {
    if (text(row[field]) === null) continue;
    const cents = decimalToCents(row[field].trim());
    if (cents === undefined) {
      errors.push(
        `${label}的${field === 'unitPrice' ? '单价' : '金额'}「${row[field]}」看不懂，最多两位小数`,
      );
      continue;
    }
    item[field] = cents;
  }

  const taxRate = text(row.taxRate);
  if (taxRate) item.taxRate = taxRate;
  return { item, errors };
}

/** 只为比较用：解析不出来就丢掉那一项（错误已经在 `parseRow` 里报过了） */
function toItem(row: ItemForm): InvoiceItem {
  return parseRow(row, '').item;
}

/**
 * 表单 → 补丁。**只放真的改过的键**，并把能看出来的错挑出来。
 */
export function diffPatch(form: CorrectForm, inv: Invoice): { patch: CorrectPatch; errors: string[] } {
  const patch: CorrectPatch = {};
  const errors: string[] = [];

  if (form.kind !== inv.kind) patch.kind = form.kind;

  for (const field of TEXT_FIELDS) {
    const next = text(form[field]);
    const raw = inv[field] as string | undefined;
    const before = raw === undefined || raw.trim() === '' ? null : raw;
    if (next !== before) patch[field] = next;
  }

  if (
    patch.issueDate !== undefined &&
    patch.issueDate !== null &&
    !/^\d{4}-\d{2}-\d{2}$/.test(patch.issueDate)
  ) {
    errors.push('开票日期要写成 2026-01-31 这样（YYYY-MM-DD）');
  }

  for (const field of MONEY_FIELDS) {
    const raw = form[field].trim();
    const before = inv[field] ?? null;
    if (raw === '') {
      if (before !== null) patch[field] = null;
      continue;
    }
    const cents = decimalToCents(raw);
    if (cents === undefined) {
      errors.push(`${MONEY_LABEL[field]}「${raw}」看不懂，最多两位小数`);
      continue;
    }
    if (cents !== before) patch[field] = cents;
  }

  const items: InvoiceItem[] = [];
  form.items.forEach((row, i) => {
    const parsed = parseRow(row, `明细 ${i + 1}`);
    items.push(parsed.item);
    errors.push(...parsed.errors);
  });
  if (JSON.stringify(items) !== JSON.stringify(inv.items.map(itemToRow).map(toItem))) {
    patch.items = items;
  }

  const pages = [...form.pages].sort((a, b) => a - b);
  // 一页都不留的票没法打印（那等于把这行删掉）。界面也不让点到这个状态，这里再兜一层
  if (pages.length > 0 && JSON.stringify(pages) !== JSON.stringify(printPagesOf(inv))) {
    patch.skipPages = Array.from({ length: Math.max(1, inv.pageCount) }, (_, i) => i).filter(
      (i) => !pages.includes(i),
    );
  }

  return { patch, errors };
}
