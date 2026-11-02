/**
 * 红冲（负数）发票的建模回归。
 *
 * 这一组钉的是「业务语义」而不是「字段提取」：
 * 一张 -5000 的票不只是「total 是负数」，它是**红冲**——
 * 汇总要抵扣、凑票要排除、查重要和原票配对、导出的表里要看得出。
 * 三处各写一次 `total < 0` 迟早会漏一处，所以判定口径只有一个 `isRedInvoice()`。
 */

import { describe, expect, it } from 'vitest';

import { chooseInvoices, combinable } from '../src/combine/index';
import { findDuplicates, isAutoDropLevel } from '../src/dedupe/index';
import { buildExportTable } from '../src/export/invoices';
import { summarizeBatch, summaryText } from '../src/export/summary';
import type { Invoice } from '../src/model/invoice';
import { applyCorrection, invoiceTotal, isRedInvoice, redMagnitude, wordsSayNegative } from '../src/model/invoice';
import { extractInvoiceFields } from '../src/parse/fields';
import { parseInvoiceFile } from '../src/parse/index';
import { buildPageText } from '../src/text/lines';
import { validateInvoice } from '../src/validate/index';

let seq = 0;
function inv(over: Partial<Invoice> = {}): Invoice {
  seq += 1;
  return {
    id: `id${seq}`,
    fileName: `f${seq}.pdf`,
    fileSize: 100,
    sha256: `hash${seq}`,
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

/** 一张 -5000.00 的红冲票（金额用「分」） */
function redInvoice(over: Partial<Invoice> = {}): Invoice {
  return inv({ total: -500000, isRed: true, ...over });
}

// ---------------------------------------------------------------------------
// 判定口径
// ---------------------------------------------------------------------------

describe('isRedInvoice —— 唯一判定口径', () => {
  it('价税合计为负 → 红冲', () => {
    expect(isRedInvoice({ total: -500000 })).toBe(true);
  });

  it('只有不含税为负也算（明细读到了、合计没读到）', () => {
    expect(isRedInvoice({ amount: -100 })).toBe(true);
  });

  it('大写金额带「负」也算（部分红冲票只在中文大写里体现方向）', () => {
    expect(isRedInvoice({ totalInWords: '负伍仟圆整' })).toBe(true);
  });

  it('正常正数票不是红冲', () => {
    expect(isRedInvoice({ total: 500000 })).toBe(false);
    expect(isRedInvoice({})).toBe(false);
  });

  it('显式 isRed=true 覆盖正数金额（票面写了红字但小写漏了负号）', () => {
    expect(isRedInvoice({ total: 500000, isRed: true })).toBe(true);
  });

  it('显式 isRed=false 覆盖负数金额（人工确认过「这不是红冲」）', () => {
    expect(isRedInvoice({ total: -500000, isRed: false })).toBe(false);
  });

  it('invoiceTotal 对红冲一律返回负数（票面漏负号时也不改口径）', () => {
    expect(invoiceTotal(inv({ isRed: true, total: 500000 }))).toBe(-500000);
    expect(invoiceTotal(inv({ total: 500000 }))).toBe(500000);
    expect(invoiceTotal(inv({ isRed: true, amount: 500000, tax: 0 }))).toBe(-500000);
  });
});

// ---------------------------------------------------------------------------
// 方向只写在文字里（大写带「负」、小写漏了负号）
//
// 这一组是「唯一口径」这条设计的反面检验：只要有一处（invoiceTotal / settle /
// validate）自己另判 `isRed === true`，就会出现「汇总说红冲 1 张抵扣了 5000，
// 合计却 +5000」的自相矛盾。所以四个出口都要钉住。
// ---------------------------------------------------------------------------

describe('方向只在大写金额里（小写漏负号）', () => {
  /** 5000 元，大写写了「负」，数字金额是正的，没人标过 isRed */
  const wordsOnly = (over: Partial<Invoice> = {}) =>
    inv({ total: 500000, totalInWords: '负伍仟圆整', ...over });

  it('invoiceTotal 按负数记账（不再只认 isRed === true）', () => {
    expect(invoiceTotal(wordsOnly())).toBe(-500000);
  });

  it('人工确认「不是红冲」时，大写里的「负」不能翻回来', () => {
    expect(invoiceTotal(wordsOnly({ isRed: false }))).toBe(500000);
  });

  it('汇总自洽：合计是 -5000，且红冲计数与抵扣额对得上', () => {
    const s = summarizeBatch([wordsOnly()]);
    expect(s.amountTotal).toBe(-500000);
    expect(s.redCount).toBe(1);
    expect(s.redTotal).toBe(500000);
    expect(summaryText(s)).toContain('-¥5,000.00');
  });

  it('校验给出 warn，并指到大写金额那一格', () => {
    const issues = validateInvoice(wordsOnly());
    const hit = issues.find((i) => i.code === 'red-invoice' && i.level === 'warn');
    expect(hit).toBeDefined();
    expect(hit?.field).toBe('totalInWords');
  });

  it('解析路径：settle() 把「大写带负」也推成 isRed，且说明里写清依据', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://www.chinatax.gov.cn/einv">
  <Main>
    <InvoiceNumber>12345678901234567891</InvoiceNumber>
    <IssueDate>2026-06-19</IssueDate>
    <SellerName>某某测试乙有限公司</SellerName>
    <SellerTaxId>9144000000000011MN</SellerTaxId>
    <AmountWithoutTax>4716.98</AmountWithoutTax>
    <TotalTax>283.02</TotalTax>
    <TotalAmountWithTax>5000.00</TotalAmountWithTax>
    <TotalAmountInWords>负伍仟圆整</TotalAmountInWords>
  </Main>
</Invoice>`;

    const outcome = await parseInvoiceFile({
      id: 'words1',
      fileName: 'words.xml',
      data: new TextEncoder().encode(xml),
      sha256: 'words1',
    });
    const parsed = outcome.invoice;
    expect(parsed.total).toBe(500000); // 原始字段保持票面样子，方便对票排查
    expect(parsed.isRed).toBe(true);
    expect(parsed.provenance.isRed?.source).toBe('derived');
    expect(invoiceTotal(parsed)).toBe(-500000);
    const issue = parsed.issues.find((i) => i.code === 'red-invoice');
    expect(issue?.field).toBe('totalInWords');
    expect(issue?.message).toContain('大写金额');
  });
});

// ---------------------------------------------------------------------------
// 「负」字认得不能太宽
//
// totalInWords 在 XML/OFD 路径上是自由文本（只限长度），一个 `test(/负/)` 就会让
// 「伍仟圆整（备注：不负任何责任）」这类备注把正常票静默变成红冲 —— 金额变负、
// 进合计、甚至和原票配成红冲对。方向必须写在金额正文之前才算数。
// ---------------------------------------------------------------------------

describe('wordsSayNegative —— 只认写在金额前面的「负」', () => {
  const say = (totalInWords: string | undefined) =>
    wordsSayNegative({ totalInWords });

  it('标准的「负伍仟圆整」', () => {
    expect(say('负伍仟圆整')).toBe(true);
  });

  it('带括号 / 人民币前缀 / 空格都算', () => {
    expect(say('（负）伍仟圆整')).toBe(true);
    expect(say('人民币负伍仟圆整')).toBe(true);
    expect(say(' 负伍仟圆整')).toBe(true);
  });

  it('繁体「負」也认', () => {
    expect(say('負伍仟圓整')).toBe(true);
  });

  it('「负」出现在金额之后（备注、说明）不算方向证据', () => {
    expect(say('伍仟圆整（备注：不负任何责任）')).toBe(false);
    expect(say('伍仟圆整 负号见小写')).toBe(false);
  });

  it('没有金额字符就不是大写金额，别拿它当证据', () => {
    expect(say('不负任何责任')).toBe(false);
    expect(say('')).toBe(false);
    expect(say(undefined)).toBe(false);
  });

  it('XML 里大写夹带「负」字的备注，不能把正常票变成红冲', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://www.chinatax.gov.cn/einv">
  <Main>
    <InvoiceNumber>12345678901234567892</InvoiceNumber>
    <IssueDate>2026-06-19</IssueDate>
    <AmountWithoutTax>4716.98</AmountWithoutTax>
    <TotalTax>283.02</TotalTax>
    <TotalAmountWithTax>5000.00</TotalAmountWithTax>
    <TotalAmountInWords>伍仟圆整（备注：不负任何责任）</TotalAmountInWords>
  </Main>
</Invoice>`;

    const outcome = await parseInvoiceFile({
      id: 'words2',
      fileName: 'note.xml',
      data: new TextEncoder().encode(xml),
      sha256: 'words2',
    });
    expect(outcome.invoice.isRed).toBeUndefined();
    expect(invoiceTotal(outcome.invoice)).toBe(500000);
    expect(summarizeBatch([outcome.invoice]).redCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 人工定过方向后，自动得出的红冲结论必须一起作废
// ---------------------------------------------------------------------------

describe('人工校正 isRed 会清掉自动红冲结论', () => {
  it('改成「不是红冲」后不再残留「识别为红冲」的说明', () => {
    const before = inv({ total: 500000, totalInWords: '负伍仟圆整' });
    const withIssue = {
      ...before,
      isRed: true as const,
      provenance: { isRed: { source: 'derived' as const, confidence: 0.9 } },
      issues: [
        {
          code: 'red-invoice' as const,
          level: 'info' as const,
          message: '识别为红冲（负数）发票：大写金额里带「负」…',
          field: 'totalInWords' as const,
        },
      ],
    };
    const after = applyCorrection(withIssue, { isRed: false });
    expect(after.isRed).toBe(false);
    expect(after.issues.some((i) => i.code === 'red-invoice')).toBe(false);
  });

  it('改别的字段时不误伤红冲说明', () => {
    const before = inv({ total: 500000 });
    const withIssue = {
      ...before,
      issues: [
        {
          code: 'red-invoice' as const,
          level: 'warn' as const,
          message: '标记为红冲，但价税合计是正数',
          field: 'total' as const,
        },
      ],
    };
    const after = applyCorrection(withIssue, { sellerName: '某某公司' });
    expect(after.issues.some((i) => i.code === 'red-invoice')).toBe(true);
  });
});

describe('redMagnitude —— 抵扣额是正数', () => {
  it('取绝对值', () => {
    expect(redMagnitude(redInvoice())).toBe(500000);
  });

  it('不是红冲就返回 undefined，不返回 0', () => {
    expect(redMagnitude(inv({ total: 500000 }))).toBeUndefined();
  });

  it('红冲但拿不到金额 → undefined（不用 0 冒充）', () => {
    expect(redMagnitude(inv({ isRed: true }))).toBeUndefined();
  });
});

describe('人工校正 isRed', () => {
  it('可以标成「不是红冲」，且不触碰其它字段', () => {
    const before = redInvoice({ sellerName: '某公司' });
    const after = applyCorrection(before, { isRed: false });
    expect(after.isRed).toBe(false);
    expect(after.sellerName).toBe('某公司');
    expect(after.provenance.isRed?.source).toBe('manual');
    expect(isRedInvoice(after)).toBe(false);
  });

  it('null 清掉标记，回到按金额推断', () => {
    const before = inv({ total: -500000, isRed: false });
    const after = applyCorrection(before, { isRed: null });
    expect(after.isRed).toBeUndefined();
    expect(isRedInvoice(after)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 解析期识别
// ---------------------------------------------------------------------------

describe('解析期识别', () => {
  const NEGATIVE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://www.chinatax.gov.cn/einv">
  <Main>
    <InvoiceNumber>12345678901234567890</InvoiceNumber>
    <IssueDate>2026-06-19</IssueDate>
    <SellerName>某某测试乙有限公司</SellerName>
    <SellerTaxId>9144000000000011MN</SellerTaxId>
    <AmountWithoutTax>-52.58</AmountWithoutTax>
    <TotalTax>-3.00</TotalTax>
    <TotalAmountWithTax>-55.58</TotalAmountWithTax>
  </Main>
</Invoice>`;

  it('XML 里金额为负 → isRed，且带 info 级说明', async () => {
    const outcome = await parseInvoiceFile({
      id: 'x1',
      fileName: 'red.xml',
      data: new TextEncoder().encode(NEGATIVE_XML),
      sha256: 'x1',
    });
    expect(outcome.invoice.total).toBe(-5558);
    expect(outcome.invoice.isRed).toBe(true);
    expect(outcome.invoice.provenance.isRed?.source).toBe('derived');
    expect(outcome.invoice.issues.some((i) => i.code === 'red-invoice')).toBe(true);
  });

  it('正常票不写 isRed（保持 undefined，别把「没判过」写成「不是」）', async () => {
    const positive = NEGATIVE_XML.replace(/-/g, '');
    const outcome = await parseInvoiceFile({
      id: 'x2',
      fileName: 'normal.xml',
      data: new TextEncoder().encode(positive),
      sha256: 'x2',
    });
    expect(outcome.invoice.isRed).toBeUndefined();
    expect(isRedInvoice(outcome.invoice)).toBe(false);
  });

  it('票面写「红字/红冲」时也能识别（票面小写漏了负号的情况）', () => {
    const page = buildPageText(0, 595, 842, [
      { text: '增值税电子普通发票（红字）', x: 40, y: 40, width: 240, height: 12 },
      { text: '价税合计（小写）¥100.00', x: 40, y: 300, width: 200, height: 12 },
    ]);
    const r = extractInvoiceFields([page]);
    expect(r.fields.isRed).toBe(true);
    expect(r.issues.some((i) => i.code === 'red-invoice')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

describe('汇总：红冲单独计数，合计是净额', () => {
  const positive = inv({ total: 500000, sellerName: '甲' });
  const red = redInvoice({ sellerName: '甲' });

  it('一正一负相抵后合计为 0，但要看得出有一张红冲', () => {
    const s = summarizeBatch([positive, red]);
    expect(s.count).toBe(2);
    expect(s.amountTotal).toBe(0);
    expect(s.redCount).toBe(1);
    expect(s.redTotal).toBe(500000);
  });

  it('全是红冲时合计为负', () => {
    const s = summarizeBatch([red, redInvoice({ total: -100000 })]);
    expect(s.amountTotal).toBe(-600000);
    expect(s.redCount).toBe(2);
    expect(s.redTotal).toBe(600000);
  });

  it('没有红冲时 redCount 为 0', () => {
    const s = summarizeBatch([positive]);
    expect(s.redCount).toBe(0);
    expect(s.redTotal).toBe(0);
  });

  it('红冲但金额没识别到时，只计数不加金额', () => {
    const s = summarizeBatch([inv({ isRed: true })]);
    expect(s.redCount).toBe(1);
    expect(s.redTotal).toBe(0);
    expect(s.missingAmount).toBe(1);
  });

  it('标记为红冲但金额是正数时，合计仍按负数抵扣（并与「-¥x」的说法一致）', () => {
    // 票面写了「红字」、但文字层把负号丢了：这是 validate 会 warn 的情况，
    // 汇总不能一边说「抵扣 5000」一边把 +5000 加进去。
    const s = summarizeBatch([inv({ isRed: true, total: 500000 })]);
    expect(s.amountTotal).toBe(-500000);
    expect(s.redTotal).toBe(500000);
    expect(s.byKind[0]!.total).toBe(-500000);
    expect(summaryText(s)).toContain('-¥5,000.00');
  });

  it('summaryText 会写明红冲抵扣，不会只给一个 0', () => {
    const text = summaryText(summarizeBatch([positive, red]));
    expect(text).toContain('金额合计：¥0.00 元');
    expect(text).toContain('红冲 1 张');
    expect(text).toContain('-¥5,000.00');
  });

  it('没有红冲时不出现红冲那一行（别制造噪音）', () => {
    expect(summaryText(summarizeBatch([positive]))).not.toContain('红冲');
  });
});

// ---------------------------------------------------------------------------
// 凑票
// ---------------------------------------------------------------------------

describe('凑票：红冲不参与，但要报出来', () => {
  const positive = inv({ total: 300000, sellerName: '甲', issueDate: '2026-06-01' });
  const red = redInvoice({ total: -100000, sellerName: '乙', issueDate: '2026-06-02' });

  it('combinable 直接过滤红冲', () => {
    expect(combinable([positive, red]).map((i) => i.id)).toEqual([positive.id]);
  });

  it('结果里带上被排除的红冲票，界面才能说明原因', () => {
    const r = chooseInvoices([positive, red], 300000);
    expect(r.picked.map((i) => i.id)).toEqual([positive.id]);
    expect(r.excludedRed.map((i) => i.id)).toEqual([red.id]);
    expect(r.sum).toBe(300000);
  });

  it('只有红冲票时给空结果，而不是把负数加进合计', () => {
    const r = chooseInvoices([red], 100000);
    expect(r.picked).toEqual([]);
    expect(r.excludedRed).toHaveLength(1);
    expect(r.sum).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 查重
// ---------------------------------------------------------------------------

describe('查重：一正一负配成一对，但绝不自动删', () => {
  const base = { sellerName: '某某销售有限公司', issueDate: '2026-06-01' };

  it('同销售方 + 同日期 + 同金额 → red-counterpart，两张都保留', () => {
    const pos = inv({ ...base, total: 500000, invoiceNo: '11111111111111111111' });
    const red = redInvoice({ ...base, total: -500000, invoiceNo: '22222222222222222222' });
    const r = findDuplicates([pos, red]);

    const pairs = r.groups.filter((g) => g.level === 'red-counterpart');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.keep).toBe(pos.id);
    expect(pairs[0]!.drop).toEqual([red.id]);
    // 关键：被「配对」的那张不能进 dropped，必须照常打印
    expect(r.kept.sort()).toEqual([pos.id, red.id].sort());
    expect(r.flagged).toContain(red.id);
  });

  it('red-counterpart 不是可自动跳过的层级', () => {
    expect(isAutoDropLevel('red-counterpart')).toBe(false);
  });

  it('日期不同 → 不配对', () => {
    const pos = inv({ ...base, total: 500000 });
    const red = redInvoice({ ...base, issueDate: '2026-07-01', total: -500000 });
    expect(findDuplicates([pos, red]).groups.filter((g) => g.level === 'red-counterpart')).toEqual([]);
  });

  it('金额大小不同 → 不配对（部分红冲不硬凑）', () => {
    const pos = inv({ ...base, total: 500000 });
    const red = redInvoice({ ...base, total: -200000 });
    expect(findDuplicates([pos, red]).groups.filter((g) => g.level === 'red-counterpart')).toEqual([]);
  });

  it('销售方不同 → 不配对', () => {
    const pos = inv({ ...base, total: 500000 });
    const red = redInvoice({ ...base, sellerName: '另一家', total: -500000 });
    expect(findDuplicates([pos, red]).groups.filter((g) => g.level === 'red-counterpart')).toEqual([]);
  });

  it('两张都是正数且金额相同，仍然走原来的「疑似重复」，不会被误判成红冲配对', () => {
    const a = inv({ ...base, total: 500000, invoiceNo: '3'.repeat(20) });
    const b = inv({ ...base, total: 500000, invoiceNo: '4'.repeat(20) });
    const levels = findDuplicates([a, b]).groups.map((g) => g.level);
    expect(levels).toContain('suspected');
    expect(levels).not.toContain('red-counterpart');
  });
});

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

describe('校验：标记与金额方向必须一致', () => {
  it('标了红冲但金额为正 → warn', () => {
    const issues = validateInvoice(inv({ total: 500000, isRed: true }));
    expect(issues.some((i) => i.code === 'red-invoice' && i.level === 'warn')).toBe(true);
  });

  it('标了「不是红冲」但金额为负 → warn', () => {
    const issues = validateInvoice(inv({ total: -500000, isRed: false }));
    expect(issues.some((i) => i.code === 'red-invoice' && i.level === 'warn')).toBe(true);
  });

  it('只有不含税金额、没有价税合计时也要查（不能只看 total）', () => {
    const issues = validateInvoice(inv({ amount: 500000, tax: 0, isRed: true }));
    expect(issues.some((i) => i.code === 'red-invoice' && i.level === 'warn')).toBe(true);
  });

  it('正常红冲（金额为负、没人工改过）不产生额外警告', () => {
    const issues = validateInvoice(inv({ total: -500000 }));
    expect(issues.filter((i) => i.code === 'red-invoice')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

describe('导出：表里有「红冲」列', () => {
  it('红冲票打「红冲」，普通票留空', () => {
    const table = buildExportTable([redInvoice(), inv({ total: 100 })], {
      fields: ['invoiceNo', 'total', 'isRed'],
      includeTotals: false,
    });
    const col = table.header.indexOf('红冲');
    expect(col).toBeGreaterThanOrEqual(0);
    expect(table.rows[0]![col]).toBe('红冲');
    expect(table.rows[1]![col]).toBeUndefined();
  });

  it('合计行与汇总口径一致（红冲按负数，不出现两个合计）', () => {
    // 票面漏了负号、但已标记红冲：导出单元格与合计行都必须是负数，
    // 否则「表里的合计」和「汇总里的合计」会给出两个不同的数。
    const table = buildExportTable(
      [inv({ isRed: true, total: 500000 }), inv({ total: 300000 })],
      { fields: ['total'], includeTotals: true },
    );
    expect(table.rows[0]![0]).toBe(-5000);
    expect(table.rows[1]![0]).toBe(3000);
    expect(table.totals?.[0]).toBe(-2000);
  });
});
