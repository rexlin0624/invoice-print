/**
 * 二维码原文 → 字段。
 *
 * **职责边界**：内核只认二维码里的**字符串**，不认图像。
 * 把图像变成字符串需要栅格化（canvas）与 WASM，那属于外壳能力
 * （网页版见 `apps/web/src/lib/qr.ts`），解出来的原文通过 `ParseInput.qrPayload` 注入。
 *
 * 数电票二维码的实测格式（两张真票实解，字段位置一致；下面的数值已换成合成值）：
 *
 *   01,32,,12345678901234567890,55.58,20260619,,300A
 *   │  │  │  │                    │       │        │ └ 4 位尾码（用途未公开，只做诊断）
 *   │  │  │  │                    │       │        └─── 校验码（数电票为空；老税控票 20 位）
 *   │  │  │  │                    │       └──────────── 开票日期 YYYYMMDD
 *   │  │  │  │                    └──────────────────── 价税合计（元）
 *   │  │  │  └───────────────────────────────────────── 发票号码
 *   │  │  └──────────────────────────────────────────── 发票代码（数电票为空）
 *   │  └─────────────────────────────────────────────── 票种代码（32 = 电子发票（普通发票））
 *   └────────────────────────────────────────────────── 固定头 01
 *
 * 另一张（通行费，合成值）：`01,32,,10987654321098765432,19.87,20260622,,6283`
 *
 * **为什么值得解二维码**：它由税务系统按同一份数据生成，
 * 号码 / 价税合计 / 开票日期 三个最要紧的字段与票面无歧义地绑定，
 * 正好可以在文字层「取错 token」时兜底，也能反过来给文字层挑错（见 §交叉校验）。
 */

import type { InvoiceKind, Issue } from '../model/invoice';
import { makeIssue } from '../model/invoice';
import type { Cents } from '../model/money';
import { decimalToCents } from '../model/money';

/**
 * 票种代码 → 票种。
 *
 * `32` 已被两张真票（普票 / 通行费普票）验证。
 * 其余来自票种代码表但**没有真样本验证过**，因此只用于「文字层没判出来时补一个粗分类」，
 * 不参与交叉校验 —— 宁可不判，也不要按一张没验证过的表去报警。
 */
const QR_KIND: Record<string, InvoiceKind> = {
  '31': 'vat-special',
  '32': 'vat-general',
  '51': 'air',
  '52': 'train',
  '61': 'toll',
};

/** 增值税家族：只有这一族才做「专票 / 普票」交叉校验，避免误报 */
const QR_VAT_FAMILY: Record<string, InvoiceKind> = {
  '31': 'vat-special',
  '32': 'vat-general',
};

export interface QrPayload {
  /** 原文，便于排查 */
  raw: string;
  /** 票种代码（原始字符串） */
  kindCode?: string;
  invoiceCode?: string;
  invoiceNo?: string;
  /** 价税合计 */
  total?: Cents;
  /** 开票日期 YYYY-MM-DD */
  issueDate?: string;
  checkCode?: string;
  /** 尾码，只进 anchors 做诊断 */
  tail?: string;
}

/** 和 XML / PDF 文字层同形的抽取结果，好走同一条合并链路 */
export interface QrExtraction {
  fields: {
    invoiceNo: string;
    invoiceCode?: string;
    total?: Cents;
    issueDate: string;
    checkCode?: string;
  };
  /** 二维码携带的字段没有单独置信度，用来源置信度 */
  confidence: Record<string, number>;
  anchors: Record<string, string>;
  issues: Issue[];
}

/** 开票日期 YYYYMMDD → YYYY-MM-DD（含合法性闸门） */
function ymd(raw: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 解析二维码原文。**认不出来就返回 `undefined`** ——
 * 发票上可能还印着别的二维码（官网、小程序、验真链接），不能拿它们当真票数据。
 */
export function parseQrPayload(raw: string): QrPayload | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  const parts = text.split(',');
  // 至少要有到「开票日期」那一段
  if (parts.length < 6) return undefined;
  if (parts[0]?.trim() !== '01') return undefined;

  const kindCode = parts[1]?.trim() ?? '';
  const invoiceCode = parts[2]?.trim() ?? '';
  const invoiceNo = parts[3]?.trim() ?? '';
  const amount = parts[4]?.trim() ?? '';
  const date = parts[5]?.trim() ?? '';

  // 发票号码是唯一不会缺席的判据：8 位老票 / 20 位数电票
  if (!/^\d{8}$|^\d{20}$/.test(invoiceNo)) return undefined;

  const issueDate = ymd(date);
  if (issueDate === undefined) return undefined;

  const total = amount === '' ? undefined : decimalToCents(amount);

  const payload: QrPayload = { raw: text, kindCode, invoiceNo, issueDate };
  if (invoiceCode !== '') payload.invoiceCode = invoiceCode;
  if (total !== undefined) payload.total = total;
  const checkCode = (parts[6] ?? '').trim();
  if (checkCode !== '') payload.checkCode = checkCode;
  const tail = (parts[7] ?? '').trim();
  if (tail !== '') payload.tail = tail;
  return payload;
}

/**
 * 二维码 → 一次「抽取结果」，好走和 XML / PDF 文字层**同一条合并链路**。
 *
 * 只产出二维码真正携带的字段：号码、代码、价税合计、日期、校验码。
 * 销售方名称、购买方、不含税金额、税额**都不在二维码里**，不要凭空造。
 */
export function extractFromQr(payload: QrPayload): QrExtraction {
  const fields: {
    invoiceNo: string;
    invoiceCode?: string;
    total?: Cents;
    issueDate: string;
    checkCode?: string;
  } = { invoiceNo: payload.invoiceNo!, issueDate: payload.issueDate! };

  if (payload.invoiceCode !== undefined) fields.invoiceCode = payload.invoiceCode;
  if (payload.total !== undefined) fields.total = payload.total;
  if (payload.checkCode !== undefined) fields.checkCode = payload.checkCode;

  return {
    fields,
    confidence: {},
    anchors: { qr: payload.raw, ...(payload.tail ? { qrTail: payload.tail } : {}) },
    issues: [],
  };
}

/**
 * 票据家族：用来判断「文字层判的票种」与「二维码票种代码」是否矛盾。
 * 返回 undefined = 不参与比较（比如 rail/air/医疗票，二维码代码表没验证过）。
 */
function family(kind: InvoiceKind): 'vat' | undefined {
  return kind === 'vat-special' || kind === 'vat-general' ? 'vat' : undefined;
}

/**
 * 交叉校验：二维码与票面文字层在「同一件事」上是否一致。
 *
 * 只在**两边都给出确定答案**时才比。不一致就是一发 `qr-mismatch` 警告，
 * 由人来看 —— 静默改掉一个用户已经在预览里看到的值，比报警更糟。
 */
export function crossCheckQr(
  payload: QrPayload,
  got: { invoiceNo?: string; total?: Cents; issueDate?: string; kind: InvoiceKind },
): Issue[] {
  const issues: Issue[] = [];

  if (got.invoiceNo !== undefined && got.invoiceNo !== payload.invoiceNo) {
    issues.push(
      makeIssue(
        'qr-mismatch',
        'warn',
        `二维码里的发票号码是 ${payload.invoiceNo}，票面文字层读到的是 ${got.invoiceNo}。请人工核对。`,
        'invoiceNo',
      ),
    );
  }

  if (payload.total !== undefined && got.total !== undefined && got.total !== payload.total) {
    issues.push(
      makeIssue(
        'qr-mismatch',
        'warn',
        `二维码里的价税合计是 ${(payload.total / 100).toFixed(2)} 元，票面文字层读到的是 ${(got.total / 100).toFixed(2)} 元。请人工核对。`,
        'total',
      ),
    );
  }

  if (got.issueDate !== undefined && got.issueDate !== payload.issueDate) {
    issues.push(
      makeIssue(
        'qr-mismatch',
        'warn',
        `二维码里的开票日期是 ${payload.issueDate}，票面文字层读到的是 ${got.issueDate}。请人工核对。`,
        'issueDate',
      ),
    );
  }

  const fromQr = QR_VAT_FAMILY[payload.kindCode ?? ''];
  if (fromQr !== undefined && family(got.kind) === 'vat' && fromQr !== got.kind) {
    const label = (k: InvoiceKind): string => (k === 'vat-special' ? '专用发票' : '普通发票');
    issues.push(
      makeIssue(
        'qr-mismatch',
        'warn',
        `二维码说是${label(fromQr)}，票面文字判的是${label(got.kind)}。请人工核对。`,
        'kind',
      ),
    );
  }

  return issues;
}

/** 二维码票种代码 → 票种（仅用于文字层没判出票种时补一个粗分类） */
export function kindFromQr(payload: QrPayload): InvoiceKind | undefined {
  return QR_KIND[payload.kindCode ?? ''];
}
