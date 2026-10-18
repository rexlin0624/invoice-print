import type { Cents } from './money';

/** 票种。用稳定的机器可读枚举，中文名走 `INVOICE_KIND_LABEL`。 */
export type InvoiceKind =
  | 'vat-special' // 增值税专用发票 / 数电专票
  | 'vat-general' // 增值税普通发票 / 数电普票（含电子发票（普通发票））
  | 'train' // 铁路电子客票
  | 'air' // 航空运输电子客票行程单
  | 'toll' // 通行费
  | 'taxi' // 出租车
  | 'ride' // 网约车
  | 'medical' // 医疗票据
  | 'nontax' // 非税收入
  | 'vehicle-tax' // 车船税
  | 'unknown';

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  'vat-special': '专票',
  'vat-general': '普票',
  train: '火车票',
  air: '行程单',
  toll: '通行费',
  taxi: '出租车',
  ride: '网约车',
  medical: '医疗',
  nontax: '非税',
  'vehicle-tax': '车船税',
  unknown: '未知',
};

/** 票种在「打印分组」时的归类：不同尺寸的票要各自成页。 */
export const INVOICE_KIND_GROUP: Record<InvoiceKind, 'standard' | 'ticket' | 'receipt'> = {
  'vat-special': 'standard',
  'vat-general': 'standard',
  toll: 'standard',
  ride: 'standard',
  medical: 'standard',
  nontax: 'standard',
  'vehicle-tax': 'standard',
  train: 'ticket',
  air: 'ticket',
  taxi: 'ticket',
  unknown: 'standard',
};

/** 字段来源。可信度从高到低排列。 */
export type FieldSource = 'xml' | 'ofd' | 'qr' | 'pdf-text' | 'ocr' | 'manual' | 'derived';

export const SOURCE_CONFIDENCE: Record<FieldSource, number> = {
  xml: 0.99,
  ofd: 0.97,
  qr: 0.95,
  'pdf-text': 0.85,
  ocr: 0.6,
  manual: 1,
  derived: 0.9,
};

/** 每个字段都带出处，避免「不知道这个值是哪来的」。 */
export interface Provenance {
  source: FieldSource;
  /** 0–1 */
  confidence: number;
}

/** 明细行（价税合计的构成）。M1 只做尽力而为的提取，允许为空。 */
export interface InvoiceItem {
  name?: string;
  spec?: string;
  unit?: string;
  quantity?: number;
  unitPrice?: Cents;
  amount?: Cents; // 不含税金额
  taxRate?: string; // 原样保留，如 "13%"
  tax?: Cents;
}

export type IssueCode =
  // 解析相关
  | 'no-text-layer'
  | 'unsupported-format'
  | 'parse-failed'
  | 'low-confidence'
  // 二维码相关
  /** 二维码与票面文字层对同一件事给出了不同答案 —— 必须人工核对 */
  | 'qr-mismatch'
  /** 只靠二维码取到字段（图片/扫描件，没有文字层） */
  | 'qr-only'
  /** 剔除了明细页（医疗票据） */
  | 'detail-page-skipped'
  /** 用离线 OCR 认出了字段（扫描件/图片） */
  | 'ocr-used'
  /** 需要 OCR 但本机没装模型 —— 说清楚怎么装上 */
  | 'ocr-unavailable'
  /** OCR 没在合理时间内出结果（后台标签页会限流渲染） */
  | 'ocr-timeout'
  /** 购销方看起来读串了（两侧同名/同税号） */
  | 'party-suspect'
  // 校验相关
  | 'amount-mismatch'
  | 'capital-mismatch'
  | 'tax-id-invalid'
  | 'invoice-no-shape'
  | 'missing-field'
  | 'date-invalid'
  // 去重 / 报销相关
  | 'duplicate-file'
  | 'duplicate-invoice-no'
  | 'suspected-duplicate'
  | 'already-reimbursed';

export interface Issue {
  code: IssueCode;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** 关联字段名，便于 UI 高亮定位 */
  field?: keyof Invoice;
}

/** 内部结构：字段值 + 出处 */
export interface Field<T> {
  value: T;
  source: FieldSource;
  confidence: number;
}

/** 唯一事实来源的发票模型。拿不到的字段就是 undefined，绝不用空串或 0 冒充。 */
export interface Invoice {
  /** 内部 id（导入时生成） */
  id: string;
  /** 来源文件名（展示用） */
  fileName: string;
  fileSize: number;
  /** 文件内容 sha256（十六进制），文件级去重依据 */
  sha256: string;

  kind: InvoiceKind;
  /** 特定业务标签，如「成品油」「通行费」「建筑服务」 */
  businessTag?: string;

  /** 发票号码：数电票 20 位，老票 8 位 */
  invoiceNo?: string;
  /** 发票代码：老票才有 */
  invoiceCode?: string;
  /** 开票日期 ISO：YYYY-MM-DD */
  issueDate?: string;

  sellerName?: string;
  sellerTaxId?: string;
  buyerName?: string;
  buyerTaxId?: string;

  /** 不含税金额 */
  amount?: Cents;
  /** 税额 */
  tax?: Cents;
  /** 价税合计（小写） */
  total?: Cents;
  /** 价税合计（大写），原样保留 */
  totalInWords?: string;
  /** 校验码（老票 20 位） */
  checkCode?: string;

  items: InvoiceItem[];

  /** 文件里的页数（跨页票按一张逻辑票处理） */
  pageCount: number;
  /**
   * 不打印的页（0 基下标）。目前只有一种来源：医疗票据的**明细页**。
   * 空/缺省 = 全部打印。用 `printablePages()` 取实际要打的页。
   */
  skipPages?: number[];
  /** 每个字段的出处 */
  provenance: Partial<Record<keyof Invoice, Provenance>>;
  /** 解析与校验过程中发现的问题 */
  issues: Issue[];

  /** 导入时间戳（ms）。内核不读时钟，由外壳传入。 */
  importedAt?: number;
}

export function makeIssue(
  code: IssueCode,
  level: Issue['level'],
  message: string,
  field?: keyof Invoice,
): Issue {
  return field === undefined ? { code, level, message } : { code, level, message, field };
}

/**
 * 实际要打印的**源文件页下标**（0 基，顺序即打印顺序）。
 *
 * 排版与打印都按「第几张要打的页」说话（`Slot.page` 是这个序号），
 * 由这里统一换算回源文件里的真实页号 —— 于是「剔除明细页」只需要维护一份 `skipPages`，
 * 不必让排版和打印各自记得哪些页不打印。
 */
export function printablePages(inv: Pick<Invoice, 'pageCount' | 'skipPages'>): number[] {
  const skip = new Set(inv.skipPages ?? []);
  const out: number[] = [];
  for (let i = 0; i < Math.max(1, inv.pageCount); i++) {
    if (!skip.has(i)) out.push(i);
  }
  // 理论上 skipPages 不会把页剔光（见 parse/medical.ts 的安全边界），兜一手
  return out.length > 0 ? out : [0];
}
