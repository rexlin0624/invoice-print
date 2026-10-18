/**
 * 从文字层抽字段。
 *
 * 全部走「锚点文字 + 相对位置」，不依赖任何绝对坐标。规则来自对真实数电票的实测
 * （见 docs/解析规则参考.md），而不是猜测。
 *
 * 已知版式（595.28 × 396.85 pt，数电票横版）：
 *
 *   y≈39   [QR]                        电子发票（普通发票）
 *   y≈39                               发票号码：12345678901234567890
 *   y≈57                               开票日期：2026年06月19日
 *   y≈103  名称：<购买方>                     名称：<销售方>
 *   y≈133  统一社会信用代码/纳税人识别号：<...>      统一社会信用代码/纳税人识别号：<...>
 *   y≈268  合计  ¥52.58  ¥3.00
 *   y≈286  价税合计（大写）伍拾伍圆伍角捌分（小写）¥55.58
 *
 * 注意：购销方是**左右分栏**，两栏的「名称：」在同一视觉行上。
 * 按国家票面标准，购买方在左/上，销售方在右/下，因此阅读顺序里第 1 个是购买方。
 */

import type { Issue, Invoice, InvoiceKind } from '../model/invoice';
import { makeIssue } from '../model/invoice';
import type { Cents } from '../model/money';
import { capitalToCents, findAmounts, hasCurrencySymbol } from '../model/money';
import type { PageText } from '../text/lines';
import type { LabelHit } from '../text/anchors';
import { findLabelTokens, inlineValue, matchAllSquashed, squash } from '../text/anchors';

export interface InvoiceExtraction {
  fields: Partial<Invoice>;
  /** 每个字段的置信度覆盖（默认取来源置信度） */
  confidence: Partial<Record<keyof Invoice, number>>;
  /** 每个字段用到的锚点文字，便于 UI 展示「这个值是从哪取的」 */
  anchors: Record<string, string>;
  issues: Issue[];
}

const CONF = {
  strong: 0.9, // 锚点明确命中
  medium: 0.75, // 正则全文匹配
  weak: 0.55, // 兜底推断
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function firstAcross<T>(pages: readonly PageText[], fn: (p: PageText) => T | undefined): T | undefined {
  for (const p of pages) {
    const r = fn(p);
    if (r !== undefined) return r;
  }
  return undefined;
}

function collectLabelHits(pages: readonly PageText[], labels: readonly string[]): LabelHit[] {
  const out: LabelHit[] = [];
  for (const p of pages) out.push(...findLabelTokens(p, labels));
  return out;
}

/** 归一化日期：支持 2026年06月19日 / 2026-06-19 / 2026/06/19 / 20260619 */
export function normalizeDate(raw: string): string | undefined {
  const s = squash(raw);
  let m = /(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 从一段文本里取「看起来像发票号码」的数字串 */
function pickInvoiceNo(raw: string): string | undefined {
  const s = squash(raw);
  const m20 = /\d{20}/.exec(s);
  if (m20) return m20[0];
  const m8 = /\b(\d{8})\b/.exec(s);
  if (m8) return m8[1];
  const any = /\d{8,25}/.exec(s);
  return any?.[0];
}

/** 从可能带 ¥ 前缀的文本里取金额 */
function pickAmount(raw: string): Cents | undefined {
  const amounts = findAmounts(raw);
  if (amounts.length > 0) return amounts[amounts.length - 1];
  // 没小数点的整数金额：只有带货币符号才认
  if (hasCurrencySymbol(raw)) {
    const m = /[¥￥]\s?(\d+(?:\.\d{1,2})?)/.exec(raw);
    if (m) {
      const parts = m[1]!.split('.');
      const whole = Number(parts[0]);
      const frac = Number((parts[1] ?? '').padEnd(2, '0') || '0');
      if (Number.isFinite(whole)) return whole * 100 + frac;
    }
  }
  return undefined;
}

/** 在右侧值里再切一层：返回第一个非空 token 文本 */
// ---------------------------------------------------------------------------
// 票种识别
// ---------------------------------------------------------------------------

interface KindRule {
  kind: InvoiceKind;
  /** 命中就判定为该票种；顺序即优先级 */
  re: RegExp;
}

// 顺序很重要：先窄后宽。「通行费」这类特定业务标签不能覆盖票种本身。
const KIND_RULES: readonly KindRule[] = [
  { kind: 'train', re: /铁路电子客票|中国铁路|铁路旅客运输/ },
  { kind: 'air', re: /航空运输电子客票行程单|电子客票行程单/ },
  { kind: 'nontax', re: /非税收入|财政票据/ },
  { kind: 'medical', re: /医疗(?:收费|门诊|住院)|医院.*票据/ },
  { kind: 'vehicle-tax', re: /车船税/ },
  { kind: 'taxi', re: /出租车|出租汽车/ },
  { kind: 'ride', re: /网约车|网络预约出租汽车|滴滴/ },
  { kind: 'toll', re: /通行费/ },
  { kind: 'vat-special', re: /(?:电子发票|增值税电子)?[（(]?增值税?专用发票[）)]?|专用发票/ },
  { kind: 'vat-general', re: /电子发票[（(]普通发票[）)]|增值税(?:电子)?普通发票|普通发票|电子普通发票/ },
];

/** 特定业务标签（票种之外的业务分类） */
const BUSINESS_TAGS = ['成品油', '通行费', '旅客运输服务', '货物运输服务', '建筑服务', '不动产经营租赁', '医疗服务', '旅游服务', '不动产销售'] as const;

function detectKind(text: string): { kind: InvoiceKind; evidence?: string } {
  const s = squash(text);
  for (const rule of KIND_RULES) {
    const m = rule.re.exec(s);
    if (m) return { kind: rule.kind, evidence: m[0] };
  }
  return { kind: 'unknown' };
}

function detectBusinessTag(text: string): string | undefined {
  const s = squash(text);
  return BUSINESS_TAGS.find((t) => s.includes(t));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const SELLER_BUYER_LABELS = ['名称：', '名称:', '名 称：'] as const;
const TAX_ID_LABELS = [
  '统一社会信用代码/纳税人识别号：',
  '统一社会信用代码/纳税人识别号:',
  '纳税人识别号：',
  '统一社会信用代码：',
] as const;
const COLUMN_STOP = [...SELLER_BUYER_LABELS, ...TAX_ID_LABELS, '统一社会信用代码', '纳税人识别号'] as const;

/** 从 pages 抽取票面字段。pages 按页序排列。 */
export function extractInvoiceFields(pages: readonly PageText[]): InvoiceExtraction {
  const fields: Partial<Invoice> = {};
  const confidence: Partial<Record<keyof Invoice, number>> = {};
  const anchors: Record<string, string> = {};
  const issues: Issue[] = [];

  if (pages.length === 0) {
    issues.push(makeIssue('no-text-layer', 'error', '文件里没有可解析的页面'));
    return { fields, confidence, anchors, issues };
  }

  const fullText = pages.map((p) => p.text).join('\n');

  // ---- 票种 ----
  const { kind, evidence } = detectKind(fullText);
  fields.kind = kind;
  if (evidence) anchors.kind = evidence;
  confidence.kind = evidence ? CONF.strong : CONF.weak;

  const tag = detectBusinessTag(fullText);
  if (tag) {
    fields.businessTag = tag;
    anchors.businessTag = tag;
    confidence.businessTag = CONF.strong;
  }

  // ---- 发票号码 ----
  const noHit = collectLabelHits(pages, ['发票号码：', '发票号码:', '发 票 号 码：'])[0];
  if (noHit) {
    const inline = inlineValue(noHit.token, noHit.label);
    const right = readRightOf(noHit);
    const no = pickInvoiceNo(inline !== '' ? inline : (right ?? ''));
    if (no) {
      fields.invoiceNo = no;
      anchors.invoiceNo = `${noHit.token.text}${no}`;
      confidence.invoiceNo = CONF.strong;
    }
  }
  if (fields.invoiceNo === undefined) {
    // 兜底：全文里的 20 位数字
    const m = /\d{20}/.exec(squash(fullText));
    if (m) {
      fields.invoiceNo = m[0];
      anchors.invoiceNo = '（全文 20 位数字兜底）';
      confidence.invoiceNo = CONF.weak;
    }
  }

  // ---- 发票代码（老票）----
  const codeHit = collectLabelHits(pages, ['发票代码：', '发票代码:'])[0];
  if (codeHit) {
    const v = squash(inlineValue(codeHit.token, codeHit.label) + (readRightOf(codeHit) ?? ''));
    const m = /\d{10,12}/.exec(v);
    if (m) {
      fields.invoiceCode = m[0];
      anchors.invoiceCode = codeHit.token.text;
      confidence.invoiceCode = CONF.strong;
    }
  }

  // ---- 开票日期 ----
  const dateHit = collectLabelHits(pages, ['开票日期：', '开票日期:', '开具日期：'])[0];
  if (dateHit) {
    const raw = inlineValue(dateHit.token, dateHit.label) + (readRightOf(dateHit) ?? '');
    const d = normalizeDate(raw);
    if (d) {
      fields.issueDate = d;
      anchors.issueDate = `${dateHit.token.text}${squash(raw)}`;
      confidence.issueDate = CONF.strong;
    }
  }
  if (fields.issueDate === undefined) {
    const m = /(\d{4}年\d{1,2}月\d{1,2}日)/.exec(squash(fullText));
    if (m) {
      const d = normalizeDate(m[1]!);
      if (d) {
        fields.issueDate = d;
        anchors.issueDate = '（全文日期兜底）';
        confidence.issueDate = CONF.medium;
      }
    }
  }

  // ---- 购销方（左右分栏：第 1 个名称 = 购买方，第 2 个 = 销售方）----
  // ⚠️ 这里必须写成 if/else-if 两条互斥分支：曾经是「if (>=1)」+「else if (===1)」，
  // 结果只有一个「名称：」时两个分支都会跑，购买方和销售方被塞成同一个名字。
  const nameHits = collectLabelHits(pages, SELLER_BUYER_LABELS);
  if (nameHits.length >= 2) {
    const first = nameHits[0]!;
    const buyer = readPartyValue(first);
    if (buyer) {
      fields.buyerName = buyer;
      anchors.buyerName = first.token.text;
      confidence.buyerName = CONF.strong;
    }
    const second = nameHits[1]!;
    const seller = readPartyValue(second);
    if (seller) {
      fields.sellerName = seller;
      anchors.sellerName = second.token.text;
      confidence.sellerName = CONF.strong;
    }
  } else if (nameHits.length === 1) {
    // 只有一个「名称：」，归属要推断。两条依据，按可靠性排序：
    //   ① 上下文里有「销售方」字样（单栏/竖版票常见）；
    //   ② 位置：国家票面标准是购销方**左右分栏，购买方在左、销售方在右**
    //      （见本文件顶部说明）。OCR 经常把「销售方」认剩一个「销」，
    //      这时位置是唯一还站得住的信息。
    const only = nameHits[0]!;
    const v = readPartyValue(only);
    const page = only.page;
    const byText = /销售方/.test(squash(fullText.slice(0, 400)));
    const byPosition =
      page !== undefined && only.token.x + only.token.width / 2 > page.width / 2;
    const isSeller = byText || byPosition;
    if (v) {
      if (isSeller) {
        fields.sellerName = v;
        anchors.sellerName = `${only.token.text}（单栏，靠${
          byText ? '「销售方」' : '右半栏位置'
        }判定）`;
      } else {
        fields.buyerName = v;
        anchors.buyerName = `${only.token.text}（单栏，默认购买方）`;
      }
      confidence.sellerName = CONF.medium;
      confidence.buyerName = CONF.medium;
    }
    issues.push(
      makeIssue('low-confidence', 'info', '票面只有一个「名称」锚点，购销方归属按上下文推断，请人工确认。', 'sellerName'),
    );
  }

  // ---- 纳税人识别号 ----
  const taxHits = collectLabelHits(pages, TAX_ID_LABELS);
  if (taxHits.length >= 1) {
    const v = readPartyValue(taxHits[0]!);
    if (v) {
      fields.buyerTaxId = v;
      anchors.buyerTaxId = taxHits[0]!.token.text;
      confidence.buyerTaxId = CONF.strong;
    }
  }
  if (taxHits.length >= 2) {
    const v = readPartyValue(taxHits[1]!);
    if (v) {
      fields.sellerTaxId = v;
      anchors.sellerTaxId = taxHits[1]!.token.text;
      confidence.sellerTaxId = CONF.strong;
    }
  }
  if (fields.sellerTaxId === undefined && fields.invoiceNo === undefined) {
    // 兜底：全文里的 18 位统一社会信用代码（2 个 → 购买方、销售方）
    const all = matchAllSquashed(pages[0]!, /[0-9A-HJ-NPQRTUWXY]{18}/g);
    const uniq = [...new Set(all.map((m) => m[0]))];
    if (uniq.length >= 1) {
      fields.buyerTaxId ??= uniq[0];
      confidence.buyerTaxId = CONF.weak;
    }
    if (uniq.length >= 2) {
      fields.sellerTaxId ??= uniq[1];
      confidence.sellerTaxId = CONF.weak;
    }
  }

  // ---- 合计（不含税金额 / 税额）----
  const sumLine = firstAcross(pages, (p) =>
    p.lines.find((l) => /合计/.test(l.text) && !/价税合计/.test(l.text)),
  );
  if (sumLine) {
    const amounts = findAmounts(sumLine.text);
    if (amounts.length >= 2) {
      fields.amount = amounts[0];
      fields.tax = amounts[1];
      anchors.amount = sumLine.text;
      anchors.tax = sumLine.text;
      confidence.amount = CONF.strong;
      confidence.tax = CONF.strong;
    } else if (amounts.length === 1) {
      fields.amount = amounts[0];
      anchors.amount = sumLine.text;
      confidence.amount = CONF.medium;
    }
  }

  // ---- 价税合计（小写 + 大写）----
  const totalLine = firstAcross(pages, (p) => p.lines.find((l) => /价税合计/.test(l.text)));
  if (totalLine) {
    const m = /价税合计[（(]?大写[）)]?([零壹贰叁肆伍陆柒捌玖拾佰仟万亿圆元角分整正〇]+)/.exec(
      squash(totalLine.text),
    );
    if (m) {
      fields.totalInWords = m[1];
      anchors.totalInWords = totalLine.text;
      confidence.totalInWords = CONF.strong;
      const cents = capitalToCents(m[1]!);
      if (cents !== undefined) {
        fields.total = cents;
        anchors.total = `${totalLine.text}（大写换算）`;
        confidence.total = CONF.strong;
      }
    }
    if (fields.total === undefined) {
      const minor =
        /[（(]小写[）)][¥￥]?\s?([\d,]+\.\d{2})/.exec(squash(totalLine.text)) ??
        /[¥￥]\s?([\d,]+\.\d{2})/.exec(squash(totalLine.text));
      if (minor) {
        const cents = pickAmount(minor[1]!);
        if (cents !== undefined) {
          fields.total = cents;
          anchors.total = totalLine.text;
          confidence.total = CONF.strong;
        }
      }
    }
  } else {
    // 没有「价税合计」行：用 合计 的两个数相加
    if (fields.amount !== undefined && fields.tax !== undefined) {
      fields.total = fields.amount + fields.tax;
      anchors.total = '（不含税 + 税额 推算）';
      confidence.total = CONF.medium;
    }
  }

  // ---- 校验码（老票 20 位，通常分 4 段）----
  const checkHit = collectLabelHits(pages, ['校验码：', '校验码:'])[0];
  if (checkHit) {
    const v = squash(inlineValue(checkHit.token, checkHit.label) + (readRightOf(checkHit) ?? ''));
    const m = /\d[\d\s]{15,30}/.exec(v);
    if (m) {
      fields.checkCode = squash(m[0]);
      anchors.checkCode = checkHit.token.text;
      confidence.checkCode = CONF.strong;
    }
  }

  // ---- 开票人 ----
  // 开票人不是发票要素（不进 Invoice 模型），但留个锚点便于 UI 展示与排查。
  const drawerHit = collectLabelHits(pages, ['开票人：', '开票人:'])[0];
  if (drawerHit) {
    const v = (inlineValue(drawerHit.token, drawerHit.label) + (readRightOf(drawerHit) ?? '')).trim();
    if (v !== '') anchors.drawer = `${drawerHit.token.text}${v}`;
  }

  return { fields, confidence, anchors, issues };
}

/**
 * 读锚点右侧的值；带「遇到下一栏就停」的保护。
 *
 * 封顶按**字符数**而不是 token 数：文本层里「某某测试销售…」通常是一个 token，
 * 而 OCR 会把它切成一个个单字 —— 按 token 数封顶（原来 6 个）会把名字截成 6 个字。
 */
const VALUE_MAX_CHARS = 48;
const VALUE_MAX_TOKENS = 24;

function readRightOf(hit: LabelHit): string | undefined {
  const located = hit.line ? { line: hit.line, index: hit.index } : undefined;
  if (!located) return undefined;

  // 空档判定随字号走：文字层 9pt 字 → 13pt 空档就算换栏；
  // OCR（1800px 图、25px 字）→ 37px 空档。见 fields.ts 顶部「购销方是左右分栏」说明。
  const heights = located.line.tokens
    .map((t) => t.height)
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b);
  const medianH = heights.length > 0 ? heights[Math.floor(heights.length / 2)]! : 0;
  const gapLimit = Math.max(6, medianH * 1.5);

  const out: string[] = [];
  let chars = 0;
  let prevRight: number | undefined;
  for (let i = located.index + 1; i < located.line.tokens.length; i++) {
    if (out.length >= VALUE_MAX_TOKENS || chars >= VALUE_MAX_CHARS) break;
    const t = located.line.tokens[i]!;
    const norm = squash(t.text);
    if (COLUMN_STOP.some((l) => norm.startsWith(squash(l)))) break;
    // 已经拿到至少一个 token 后，遇到大空档就停 —— 否则会把隔壁那一栏的字吃进来
    // （实测：购买方名字后面跟了销售方栏的「销」）
    if (out.length > 0 && prevRight !== undefined && t.x - prevRight > gapLimit) break;
    out.push(t.text);
    prevRight = t.x + t.width;
    chars += norm.length;
  }
  return out.length > 0 ? out.join('') : undefined;
}

/** 购销方字段：锚点右侧、到下一栏之前的所有 token 拼起来（含锚点 token 里的内联值） */
function readPartyValue(hit: LabelHit): string | undefined {
  const inline = inlineValue(hit.token, hit.label);
  const right = readRightOf(hit) ?? '';
  const v = (inline + right).trim();
  return v === '' ? undefined : v;
}

/** 便于外壳展示：这个文件用了哪些取数方式 */
export function describeExtraction(x: InvoiceExtraction): string {
  const keys = Object.keys(x.anchors);
  if (keys.length === 0) return '未识别到任何字段';
  return keys.map((k) => `${k}←${x.anchors[k]}`).join('；');
}
