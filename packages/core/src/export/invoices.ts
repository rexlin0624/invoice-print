/**
 * 导出汇总表：一份**表格数据**，CSV 与 XLSX 两个渲染器都从它出发。
 *
 * 为什么要抽出来：参考项目里 CSV 和 Excel 各写一遍取字段的逻辑，
 * 结果是「CSV 有发票代码、Excel 没有」这类不一致。这里只有一份口径。
 *
 * 两个必须踩准的坑：
 * 1. **长数字串**（20 位发票号码）写成数字会被 Excel 弄成科学计数法并丢末尾精度。
 *    所以号码/代码/税号一律按**文本**输出，并且 CSV 里要加 `="…"` 保护。
 * 2. **金额**列必须是**数字**才能合计。内核里金额是整数「分」，
 *    到表格边界才换算成元（两位小数）—— 这是唯一允许出现小数的位置。
 */

import type { Invoice } from '../model/invoice';
import { INVOICE_KIND_LABEL } from '../model/invoice';

export type ExportField =
  | 'fileName'
  | 'kind'
  | 'businessTag'
  | 'invoiceNo'
  | 'invoiceCode'
  | 'checkCode'
  | 'issueDate'
  | 'sellerName'
  | 'sellerTaxId'
  | 'buyerName'
  | 'buyerTaxId'
  | 'amount'
  | 'tax'
  | 'total'
  | 'totalInWords'
  | 'mark'
  | 'importedAt';

export type CellKind = 'text' | 'money' | 'date' | 'datetime';

export interface ExportColumn {
  field: ExportField;
  label: string;
  kind: CellKind;
  /** Excel 列宽（字符数） */
  width: number;
  /** 默认选中 */
  on: boolean;
}

/** 列定义顺序也是 Excel 里的列顺序 */
export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { field: 'issueDate', label: '开票日期', kind: 'date', width: 12, on: true },
  { field: 'invoiceNo', label: '发票号码', kind: 'text', width: 24, on: true },
  { field: 'kind', label: '票种', kind: 'text', width: 16, on: true },
  { field: 'sellerName', label: '销售方', kind: 'text', width: 30, on: true },
  { field: 'total', label: '价税合计', kind: 'money', width: 12, on: true },
  { field: 'amount', label: '不含税金额', kind: 'money', width: 12, on: true },
  { field: 'tax', label: '税额', kind: 'money', width: 11, on: true },
  { field: 'buyerName', label: '购买方', kind: 'text', width: 30, on: false },
  { field: 'invoiceCode', label: '发票代码', kind: 'text', width: 16, on: false },
  { field: 'checkCode', label: '校验码', kind: 'text', width: 24, on: false },
  { field: 'sellerTaxId', label: '销售方税号', kind: 'text', width: 22, on: false },
  { field: 'buyerTaxId', label: '购买方税号', kind: 'text', width: 22, on: false },
  { field: 'businessTag', label: '特定业务', kind: 'text', width: 14, on: false },
  { field: 'totalInWords', label: '价税合计(大写)', kind: 'text', width: 26, on: false },
  { field: 'mark', label: '状态', kind: 'text', width: 10, on: false },
  { field: 'fileName', label: '文件名', kind: 'text', width: 34, on: false },
  { field: 'importedAt', label: '导入时间', kind: 'datetime', width: 18, on: false },
];

export type MarkValue = 'printed' | 'reimbursed';

export interface ExportTable {
  columns: ExportColumn[];
  header: string[];
  rows: Array<Array<string | number | undefined>>;
  /** 数字列（金额），Excel 求和与右对齐用 */
  numeric: boolean[];
  /** 合计行（只对数字列给值）。`includeTotals` 为假时不生成。 */
  totals: Array<string | number | undefined> | undefined;
  /** 表格首行的说明（比如筛选条件），可空 */
  caption?: string;
}

export interface ExportTableOptions {
  fields?: readonly ExportField[];
  marks?: Readonly<Record<string, MarkValue>>;
  includeTotals?: boolean;
  /** 合计行第一列写什么 */
  totalsLabel?: string;
  /** 只要这些（比如「已报销库」导出时已筛过） */
  caption?: string;
}

const MARK_LABEL: Record<MarkValue, string> = { printed: '已打印', reimbursed: '已报销' };

/** 分 → 元。**只在表格边界上做这一次换算** */
export function centsToYuan(cents: number): number {
  return Math.round(cents) / 100;
}

function cellFor(inv: Invoice, field: ExportField, marks: Readonly<Record<string, MarkValue>>): string | number | undefined {
  switch (field) {
    case 'fileName':
      return inv.fileName;
    case 'kind':
      return INVOICE_KIND_LABEL[inv.kind];
    case 'businessTag':
      return inv.businessTag;
    case 'invoiceNo':
      return inv.invoiceNo;
    case 'invoiceCode':
      return inv.invoiceCode;
    case 'checkCode':
      return inv.checkCode;
    case 'issueDate':
      return inv.issueDate;
    case 'sellerName':
      return inv.sellerName;
    case 'sellerTaxId':
      return inv.sellerTaxId;
    case 'buyerName':
      return inv.buyerName;
    case 'buyerTaxId':
      return inv.buyerTaxId;
    case 'amount':
      return inv.amount === undefined ? undefined : centsToYuan(inv.amount);
    case 'tax':
      return inv.tax === undefined ? undefined : centsToYuan(inv.tax);
    case 'total':
      return inv.total === undefined ? undefined : centsToYuan(inv.total);
    case 'totalInWords':
      return inv.totalInWords;
    case 'mark': {
      const mark = marks[inv.id];
      return mark === undefined ? undefined : MARK_LABEL[mark];
    }
    case 'importedAt':
      return inv.importedAt === undefined ? undefined : toLocalDateTime(inv.importedAt);
  }
}

/** 时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。Excel 里当文本更省事，也更好读。 */
export function toLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildExportTable(
  invoices: readonly Invoice[],
  options: ExportTableOptions = {},
): ExportTable {
  const marks = options.marks ?? {};
  const wanted = options.fields ?? EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.field);
  // 保序：按列定义顺序，而不是用户勾选顺序
  const columns = EXPORT_COLUMNS.filter((c) => wanted.includes(c.field));
  const numeric = columns.map((c) => c.kind === 'money');

  const rows = invoices.map((inv) => columns.map((c) => cellFor(inv, c.field, marks)));

  let totals: ExportTable['totals'];
  if (options.includeTotals !== false) {
    totals = columns.map((_, i) => (numeric[i] ? 0 : undefined));
    for (const row of rows) {
      row.forEach((value, i) => {
        if (numeric[i] && typeof value === 'number') {
          totals![i] = Math.round(((totals![i] as number) + value) * 100) / 100;
        }
      });
    }
    if (!numeric.some(Boolean)) {
      totals = undefined;
    } else {
      // 标签写在**第一个非金额列**上。不能无脑写第 0 列 ——
      // 用户只勾了「价税合计」一列时，那正好是第 0 列，会把合计值覆盖成文字。
      const labelAt = numeric.findIndex((isMoney) => !isMoney);
      if (labelAt >= 0) totals[labelAt] = options.totalsLabel ?? `合计 ${invoices.length} 张`;
    }
  }

  return {
    columns,
    header: columns.map((c) => c.label),
    rows,
    numeric,
    totals,
    ...(options.caption !== undefined ? { caption: options.caption } : {}),
  };
}

/**
 * 长数字串保护。
 *
 * Excel 对「看起来像数字的文本」会自作主张转成数值：20 位发票号码会变成
 * `1.2346E+19` 并且**末尾几位变 0**。CSV 里没法指定单元格类型，
 * 唯一的通用解法是写出 `="12345678901234567890"` 这种公式式文本，
 * Excel 打开就是文本，Numbers / WPS 也认。
 */
export function guardLongDigits(text: string): string {
  return /^\d{15,}$/.test(text) ? `="${text}"` : text;
}

/** RFC4180 转义 + 长数字串保护 */
function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'number') return String(value);
  return `"${guardLongDigits(value).replace(/"/g, '""')}"`;
}

/** 表格 → CSV（UTF-8；调用方负责加 BOM，见 apps/web 的下载实现） */
export function tableToCsv(table: ExportTable): string {
  const lines: string[] = [];
  if (table.caption) lines.push(csvCell(table.caption));
  lines.push(table.header.map(csvCell).join(','));
  for (const row of table.rows) lines.push(row.map(csvCell).join(','));
  if (table.totals) lines.push(table.totals.map(csvCell).join(','));
  return lines.join('\r\n');
}
