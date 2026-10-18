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

  const no = pick(flat, K.invoiceNo);
  if (no) set('invoiceNo', no.key, no.value.replace(/\s/g, ''));

  const code = pick(flat, K.invoiceCode);
  if (code) set('invoiceCode', code.key, code.value.replace(/\s/g, ''));

  const date = pick(flat, K.issueDate);
  if (date) {
    const d = normalizeDate(date.value);
    if (d) set('issueDate', date.key, d);
    else issues.push(makeIssue('date-invalid', 'warn', `开票日期无法识别：${date.value}`, 'issueDate'));
  }

  const seller = pick(flat, K.sellerName);
  if (seller) set('sellerName', seller.key, seller.value);
  const sellerTax = pick(flat, K.sellerTaxId);
  if (sellerTax) set('sellerTaxId', sellerTax.key, sellerTax.value.replace(/\s/g, ''));

  const buyer = pick(flat, K.buyerName);
  if (buyer) set('buyerName', buyer.key, buyer.value);
  const buyerTax = pick(flat, K.buyerTaxId);
  if (buyerTax) set('buyerTaxId', buyerTax.key, buyerTax.value.replace(/\s/g, ''));

  const amount = pick(flat, K.amount);
  if (amount) {
    const c = toCents(amount.value);
    if (c !== undefined) set('amount', amount.key, c);
  }
  const tax = pick(flat, K.tax);
  if (tax) {
    const c = toCents(tax.value);
    if (c !== undefined) set('tax', tax.key, c);
  }
  const total = pick(flat, K.total);
  if (total) {
    const c = toCents(total.value);
    if (c !== undefined) set('total', total.key, c);
  }
  const words = pick(flat, K.totalInWords);
  if (words) {
    set('totalInWords', words.key, words.value);
    if (fields.total === undefined) {
      const c = capitalToCents(words.value);
      if (c !== undefined) set('total', words.key, c);
    }
  }

  const raw: Record<string, string[]> = {};
  for (const [k, v] of flat.elements) raw[k] = v;

  return { fields, confidence, anchors, issues, raw };
}

function toCents(text: string): Cents | undefined {
  return decimalToCents(text);
}
