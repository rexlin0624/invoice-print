/**
 * 数电票 / 老票 XML 解析。
 *
 * 设计取舍：**不做 schema 绑定**。各厂商、各省的 XML 方言差异极大（元素名有
 * 英文驼峰、下划线、中文三种风格，值有时在属性里），写死路径的解析器一改版就废。
 * 这里把整棵树拍平成「归一化键 → 值」，再按**优先级候选表**取字段。
 * 这是技术方案里「fast-xml-parser 字段最准，优先级最高」的落地方式。
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import type { Issue, Invoice } from '../model/invoice';
import { makeIssue } from '../model/invoice';
import type { Cents } from '../model/money';
import { capitalToCents, decimalToCents } from '../model/money';
import { normalizeDate } from './fields';

export interface MapExtraction {
  fields: Partial<Invoice>;
  confidence: Partial<Record<keyof Invoice, number>>;
  anchors: Record<string, string>;
  issues: Issue[];
  /** 拍平后的全部键值，便于诊断「某个方言没被识别」 */
  raw: Record<string, string[]>;
}

/** 名称/大写金额等自由文本的上限（字符）。真实值远小于此。 */
const MAX_TEXT_FIELD_CHARS = 200;

/** 报错里引用原文时要截断，别把 19 MB 的字段抄进日志/界面 */
function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 归一化键名：小写、去掉命名空间前缀与非字母数字（中文保留） */
export function normalizeKey(key: string): string {
  return key
    .replace(/^@_?/, '')
    .toLowerCase()
    .replace(/^[a-z0-9]+:/, '') // 去 ofd: / ns0: 之类的前缀
    .replace(/[^0-9a-z\u4e00-\u9fff]/g, '');
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // 关键：不要让 fast-xml-parser 把 "12345678901234567890" 变成数字丢精度
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: () => false,
  allowBooleanAttributes: true,
});

interface FlatTree {
  elements: Map<string, string[]>;
  attributes: Map<string, string[]>;
}

function flatten(node: unknown, out: FlatTree, isAttribute = false): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out, isAttribute);
    return;
  }
  if (typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const attr = isAttribute || key.startsWith('@_');
    if (value !== null && typeof value === 'object') {
      flatten(value, out, attr);
      continue;
    }
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    const normalized = normalizeKey(key);
    if (normalized === '') continue;
    const bucket = attr ? out.attributes : out.elements;
    const list = bucket.get(normalized);
    if (list) list.push(text);
    else bucket.set(normalized, [text]);
  }
}

/**
 * 取第一个**通过校验**的候选值。
 *
 * 原来的 `pick` 只取每个候选键的第一个值：候选表里排前面的键如果给了个坏值
 * （`<Fphm>---</Fphm>`），后面那些键就算有正常值也拿不到 —— 一张真票因此丢号码，
 * 连带失去去重能力和打印标题。所以「取哪个键」与「值能不能用」必须一起判断。
 *
 * 元素优先于属性（`<Fphm>` 比 `Fphm="…"` 更像正主），同一键内也只认能过校验的那个。
 */
function pickWhere(
  flat: FlatTree,
  candidates: readonly string[],
  accept: (value: string) => boolean,
): { key: string; value: string } | undefined {
  for (const c of candidates) {
    const k = normalizeKey(c);
    const values = [flat.elements.get(k)?.[0], flat.attributes.get(k)?.[0]];
    for (const value of values) {
      if (value !== undefined && accept(value)) return { key: k, value };
    }
  }
  return undefined;
}

/** 不做校验的取法：只用来拿「第一个值」写进 issue 文案 */
function pick(flat: FlatTree, candidates: readonly string[]): { key: string; value: string } | undefined {
  for (const c of candidates) {
    const k = normalizeKey(c);
    const fromElement = flat.elements.get(k)?.[0];
    if (fromElement !== undefined) return { key: k, value: fromElement };
    const fromAttr = flat.attributes.get(k)?.[0];
    if (fromAttr !== undefined) return { key: k, value: fromAttr };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 候选键表（顺序 = 优先级）
// ---------------------------------------------------------------------------

const K = {
  invoiceNo: [
    'InvoiceNumber', 'InvoiceNo', 'invoice_num', 'EInvoiceNumber', 'DigitalInvoiceNo',
    'Fphm', 'fphm', 'BillNo', 'BillNumber', '发票号码',
  ],
  invoiceCode: ['InvoiceCode', 'invoice_code', 'Fpdm', 'fpdm', 'BillCode', '发票代码'],
  issueDate: [
    'IssueDate', 'IssuedDate', 'IssuingDate', 'InvoiceDate', 'MakeOutDate',
    'Kprq', 'kprq', 'BillDate', '开票日期', '开具日期',
  ],
  sellerName: [
    'SellerName', 'SalePartyName', 'SalesPartyName', 'Seller', 'Xsfmc', 'xsfmc',
    'SalesName', '销方名称', '销售方名称', '销售方',
  ],
  sellerTaxId: [
    'SellerTaxId', 'SellerTaxNo', 'SaleTaxId', 'SalesTaxId', 'SalesPartyTaxId',
    'Xsfsbh', 'xsfsbh', '销方税号', '销售方纳税人识别号', '销售方识别号',
  ],
  buyerName: [
    'BuyerName', 'PurchaserName', 'BuyingPartyName', 'Buyer', 'Gmfmc', 'gmfmc',
    '购方名称', '购买方名称', '购买方',
  ],
  buyerTaxId: [
    'BuyerTaxId', 'BuyerTaxNo', 'PurchaserTaxId', 'PurchaserTaxNo',
    'Gmfsbh', 'gmfsbh', '购方税号', '购买方纳税人识别号', '购买方识别号',
  ],
  amount: [
    'AmountWithoutTax', 'AmountExclTax', 'NetAmount', 'TotalAmountWithoutTax',
    'WithoutTaxAmount', 'Je', 'je', '不含税金额', '金额',
  ],
  tax: ['TotalTax', 'TaxAmount', 'Tax', 'Se', 'se', '税额', '合计税额'],
  total: [
    'TotalAmountWithTax', 'AmountWithTax', 'GrandTotal', 'TotalWithTax',
    'Jshj', 'jshj', '价税合计', '含税金额', '价税合计小写',
  ],
  totalInWords: [
    'TotalAmountInWords', 'AmountInWords', 'Jshjdx', 'jshjdx', '大写金额', '价税合计大写',
  ],
  kind: ['InvoiceType', 'InvoiceKind', 'BillType', '票种'],
} as const;

const CONF_STRONG = 0.99;

/** 解析 XML 文本 → 票面字段。不抛异常。 */
export function parseInvoiceXml(xml: string): MapExtraction {
  const fields: Partial<Invoice> = {};
  const confidence: Partial<Record<keyof Invoice, number>> = {};
  const anchors: Record<string, string> = {};
  const issues: Issue[] = [];
  let flat: FlatTree = { elements: new Map(), attributes: new Map() };

  try {
    // 先校验结构：宁可报一条「结构有问题」，也不要静默地少读一堆字段
    const valid = XMLValidator.validate(xml);
    if (valid !== true) {
      issues.push(
        makeIssue(
          'parse-failed',
          'warn',
          `XML 结构有问题：${valid.err.msg}（第 ${valid.err.line} 行）`,
        ),
      );
    }
    const parsed = parser.parse(xml);
    flatten(parsed, flat);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    issues.push(makeIssue('parse-failed', 'error', `XML 解析失败：${message}`));
    return { fields, confidence, anchors, issues, raw: {} };
  }

  const set = <T>(field: keyof Invoice, key: string, value: T): void => {
    (fields as Record<string, unknown>)[field] = value;
    confidence[field] = CONF_STRONG;
    anchors[field] = `<${key}>`;
  };

  /**
   * 名称/大写金额这类自由文本：只限长度，不改内容。
   *
   * 不设上限的话，一个 19 MB 的 `<SellerName>` 会被原样带进列表、去重比较、
   * 打印排版和备份文件 —— 每处都再复制一遍。真实名称不会超过几十个字。
   */
  const setText = (field: keyof Invoice, picked: { key: string; value: string }): void => {
    if (picked.value.length <= MAX_TEXT_FIELD_CHARS) {
      set(field, picked.key, picked.value);
      return;
    }
    issues.push(
      makeIssue(
        'field-invalid',
        'warn',
        `XML 里的字段过长（${picked.value.length} 字，上限 ${MAX_TEXT_FIELD_CHARS}），已忽略：${clip(picked.value)}`,
        field,
      ),
    );
  };

  /** 税号：15–20 位字母数字。形状不对就不收，避免污染「同税号」判定。 */
  const setTaxId = (field: 'sellerTaxId' | 'buyerTaxId', picked: { key: string; value: string }): void => {
    const value = picked.value.replace(/\s/g, '');
    if (/^[0-9A-Za-z]{15,20}$/.test(value)) {
      set(field, picked.key, value);
      return;
    }
    issues.push(
      makeIssue(
        'tax-id-invalid',
        'warn',
        `XML 里的税号形态异常（${value.length} 位），已忽略该字段：${clip(value)}`,
        field,
      ),
    );
  };

  /** 只留数字（税号还留字母）：写法与旧版一致，比较/截断都按去空白后的值算 */
  const squashed = (value: string): string => value.replace(/\s/g, '');

  /** 候选里第一个值过不了校验时，把它写进 issue —— 让人知道「这里有东西，但没收」 */
  const reportRejected = (
    field: keyof Invoice,
    candidates: readonly string[],
    issueCode: 'invoice-no-shape' | 'tax-id-invalid' | 'date-invalid' | 'field-invalid',
    message: (value: string) => string,
  ): void => {
    const first = pick(flat, candidates);
    if (!first) return;
    issues.push(makeIssue(issueCode, 'warn', message(first.value), field));
  };

  const no = pickWhere(flat, K.invoiceNo, (value) => /^\d{8,20}$/.test(squashed(value)));
  if (no) set('invoiceNo', no.key, squashed(no.value));
  else {
    // 号码是去重的**唯一键**：形状不对就直接不收。
    // 否则一段乱码也能当「同号票」把真票挤掉（见 dedupe 的 invoice-no 组）。
    reportRejected(
      'invoiceNo',
      K.invoiceNo,
      'invoice-no-shape',
      (value) =>
        `XML 里的发票号码形态异常（${squashed(value).length} 位），已忽略该字段：${clip(value)}`,
    );
  }

  const code = pickWhere(flat, K.invoiceCode, (value) => /^\d{10,12}$/.test(squashed(value)));
  if (code) set('invoiceCode', code.key, squashed(code.value));
  else {
    // 老票代码 10/12 位；数电票没有代码。放宽到 10–12 位数字。
    reportRejected(
      'invoiceCode',
      K.invoiceCode,
      'invoice-no-shape',
      (value) =>
        `XML 里的发票代码形态异常（${squashed(value).length} 位），已忽略该字段：${clip(value)}`,
    );
  }

  const date = pickWhere(flat, K.issueDate, (value) => normalizeDate(value) !== undefined);
  if (date) set('issueDate', date.key, normalizeDate(date.value)!);
  else {
    reportRejected(
      'issueDate',
      K.issueDate,
      'date-invalid',
      (value) => `开票日期无法识别：${clip(value)}`,
    );
  }

  const seller = pickWhere(flat, K.sellerName, (value) => value.length <= MAX_TEXT_FIELD_CHARS);
  if (seller) setText('sellerName', seller);
  else {
    reportRejected('sellerName', K.sellerName, 'field-invalid', (value) =>
      `XML 里的字段过长（${value.length} 字，上限 ${MAX_TEXT_FIELD_CHARS}），已忽略：${clip(value)}`,
    );
  }
  const sellerTax = pickWhere(flat, K.sellerTaxId, (value) => /^[0-9A-Za-z]{15,20}$/.test(squashed(value)));
  if (sellerTax) setTaxId('sellerTaxId', sellerTax);
  else {
    reportRejected('sellerTaxId', K.sellerTaxId, 'tax-id-invalid', (value) =>
      `XML 里的税号形态异常（${squashed(value).length} 位），已忽略该字段：${clip(value)}`,
    );
  }

  const buyer = pickWhere(flat, K.buyerName, (value) => value.length <= MAX_TEXT_FIELD_CHARS);
  if (buyer) setText('buyerName', buyer);
  else {
    reportRejected('buyerName', K.buyerName, 'field-invalid', (value) =>
      `XML 里的字段过长（${value.length} 字，上限 ${MAX_TEXT_FIELD_CHARS}），已忽略：${clip(value)}`,
    );
  }
  const buyerTax = pickWhere(flat, K.buyerTaxId, (value) => /^[0-9A-Za-z]{15,20}$/.test(squashed(value)));
  if (buyerTax) setTaxId('buyerTaxId', buyerTax);
  else {
    reportRejected('buyerTaxId', K.buyerTaxId, 'tax-id-invalid', (value) =>
      `XML 里的税号形态异常（${squashed(value).length} 位），已忽略该字段：${clip(value)}`,
    );
  }

  const amount = pickWhere(flat, K.amount, (value) => toCents(value) !== undefined);
  if (amount) set('amount', amount.key, toCents(amount.value)!);
  const tax = pickWhere(flat, K.tax, (value) => toCents(value) !== undefined);
  if (tax) set('tax', tax.key, toCents(tax.value)!);
  const total = pickWhere(flat, K.total, (value) => toCents(value) !== undefined);
  if (total) set('total', total.key, toCents(total.value)!);
  const words = pickWhere(flat, K.totalInWords, (value) => value.length <= MAX_TEXT_FIELD_CHARS);
  if (words) {
    setText('totalInWords', words);
    if (fields.total === undefined) {
      const c = capitalToCents(words.value);
      if (c !== undefined) set('total', words.key, c);
      else {
        issues.push(
          makeIssue(
            'field-invalid',
            'warn',
            `大写金额无法识别：${clip(words.value)}`,
            'totalInWords',
          ),
        );
      }
    }
  } else {
    reportRejected('totalInWords', K.totalInWords, 'field-invalid', (value) =>
      `XML 里的字段过长（${value.length} 字，上限 ${MAX_TEXT_FIELD_CHARS}），已忽略：${clip(value)}`,
    );
  }

  const raw: Record<string, string[]> = {};
  for (const [k, v] of flat.elements) raw[k] = v;

  return { fields, confidence, anchors, issues, raw };
}

function toCents(text: string): Cents | undefined {
  return decimalToCents(text);
}
