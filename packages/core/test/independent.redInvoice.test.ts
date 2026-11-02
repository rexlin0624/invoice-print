/**
 * 独立验收：红冲（负数）发票建模（N-01）。
 *
 * 只按验收标准写断言，不看实现「想怎么做」：
 *   - 判定口径唯一（汇总 / 凑票 / 查重 / 导出 / 校验都按 `isRedInvoice()` 的语义走）
 *   - 来源覆盖（XML 负数、票面字样 / OCR、人工三态）
 *   - 边界（折扣票、免税票、部分红冲、缺金额、标记与金额方向冲突、配对不跳过）
 *
 * 与 `redInvoice.test.ts` 的区别：这里的用例是**独立造的**，并且刻意去撞
 * 「同一件事被两处各算一遍」会露馅的组合（折扣票、部分红冲、正数金额的红冲标记）。
 */

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { chooseInvoices, combinable } from '../src/combine/index';
import { findDuplicates, isAutoDropLevel } from '../src/dedupe/index';
import { buildExportTable } from '../src/export/invoices';
import { summarizeBatch, summaryText } from '../src/export/summary';
import type { Invoice } from '../src/model/invoice';
import { applyCorrection, invoiceTotal, isRedInvoice } from '../src/model/invoice';
import { extractInvoiceFields } from '../src/parse/fields';
import type { OcrPageInput } from '../src/parse/index';
import { parseInvoiceFile } from '../src/parse/index';
import type { PageText } from '../src/text/lines';
import { buildPageText } from '../src/text/lines';
import { validateInvoice } from '../src/validate/index';

let seq = 0;
function inv(over: Partial<Invoice> = {}): Invoice {
  seq += 1;
  return {
    id: `ind-${seq}`,
    fileName: `ind-${seq}.pdf`,
    fileSize: 1,
    sha256: `ind-${seq}`,
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

function fieldsOf(page: PageText) {
  return extractInvoiceFields([page]);
}

// ---------------------------------------------------------------------------
// 边界：不该被当成红冲的票
// ---------------------------------------------------------------------------

describe('边界：折扣票不能被误判为红冲', () => {
  // 折扣票的特征：不含税金额是正数、税额是负数，价税合计仍然是正数
  const discounted = inv({ amount: 100_000, tax: -10_000, total: 90_000 });

  it('金额为正 + 税额为负 → 不是红冲', () => {
    expect(isRedInvoice(discounted)).toBe(false);
    expect(invoiceTotal(discounted)).toBe(90_000);
  });

  it('折扣票按普通票参与凑票 / 计入合计 / 不带红冲标记', () => {
    expect(combinable([discounted]).map((i) => i.id)).toEqual([discounted.id]);

    const s = summarizeBatch([discounted]);
    expect(s.amountTotal).toBe(90_000);
    expect(s.redCount).toBe(0);
    expect(s.redTotal).toBe(0);
    expect(summaryText(s)).not.toContain('红冲');

    expect(validateInvoice(discounted).filter((i) => i.code === 'red-invoice')).toEqual([]);

    const table = buildExportTable([discounted], { fields: ['total', 'isRed'], includeTotals: false });
    const col = table.header.indexOf('红冲');
    expect(table.rows[0]![col]).toBeUndefined();
  });

  it('折扣票读不到价税合计（只有 金额 + 负税额）时也不判红冲', () => {
    const noTotal = inv({ amount: 100_000, tax: -10_000 });
    expect(invoiceTotal(noTotal)).toBe(90_000);
    expect(isRedInvoice(noTotal)).toBe(false);
  });
});

describe('边界：免税票（tax = 0）', () => {
  const exempt = inv({ amount: 50_000, tax: 0, total: 50_000 });

  it('是普通票，税额合计为 0 而不是「没读到」', () => {
    expect(isRedInvoice(exempt)).toBe(false);
    const s = summarizeBatch([exempt]);
    expect(s.redCount).toBe(0);
    expect(s.taxTotal).toBe(0);
    expect(s.missingAmount).toBe(0);
    expect(s.amountTotal).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// 边界：部分红冲不配对
// ---------------------------------------------------------------------------

describe('边界：部分红冲不硬凑成配对', () => {
  const base = { sellerName: '某某销售有限公司', issueDate: '2026-06-01' };

  it('-2000 对 +5000 → 没有 red-counterpart 组', () => {
    const pos = inv({ ...base, total: 500_000, invoiceNo: '1'.repeat(20) });
    const red = inv({ ...base, total: -200_000, isRed: true, invoiceNo: '2'.repeat(20) });
    const r = findDuplicates([pos, red]);
    expect(r.groups.filter((g) => g.level === 'red-counterpart')).toEqual([]);
    expect(r.kept.sort()).toEqual([pos.id, red.id].sort());
  });

  it('-2000 对 +2000（部分红冲累计到全额时）→ 配成一对', () => {
    const pos = inv({ ...base, total: 200_000, invoiceNo: '3'.repeat(20) });
    const red = inv({ ...base, total: -200_000, isRed: true, invoiceNo: '4'.repeat(20) });
    const groups = findDuplicates([pos, red]).groups.filter((g) => g.level === 'red-counterpart');
    expect(groups).toHaveLength(1);
  });

  it('红冲标记在、但金额漏了负号（isRed + 正数）→ 仍然按红冲配对', () => {
    const pos = inv({ ...base, total: 100_000, invoiceNo: 'a'.repeat(20) });
    const signLost = inv({ ...base, total: 100_000, isRed: true, invoiceNo: 'b'.repeat(20) });
    const groups = findDuplicates([pos, signLost]).groups.filter((g) => g.level === 'red-counterpart');
    expect(groups).toHaveLength(1);
  });

  it('两张都是红冲 → 不配对（没有正数原票）', () => {
    const a = inv({ ...base, total: -200_000, isRed: true });
    const b = inv({ ...base, total: -200_000, isRed: true });
    expect(findDuplicates([a, b]).groups.filter((g) => g.level === 'red-counterpart')).toEqual([]);
  });

  it('一张正票 + 两张同额红冲 → 每张红冲都被点名，且两张红冲都不进 dropped', () => {
    const pos = inv({ ...base, total: 100_000, invoiceNo: '5'.repeat(20) });
    const red1 = inv({ ...base, total: -100_000, isRed: true, invoiceNo: '6'.repeat(20) });
    const red2 = inv({ ...base, total: -100_000, isRed: true, invoiceNo: '7'.repeat(20) });
    const r = findDuplicates([pos, red1, red2]);
    const pairs = r.groups.filter((g) => g.level === 'red-counterpart');
    expect(pairs).toHaveLength(2);
    expect(r.kept.sort()).toEqual([pos.id, red1.id, red2.id].sort());
    expect(r.flagged.sort()).toEqual([red1.id, red2.id].sort());
  });
});

// ---------------------------------------------------------------------------
// 边界：一正一负配对后两张都必须留下
// ---------------------------------------------------------------------------

describe('边界：配对只提示，绝不自动跳过', () => {
  const base = { sellerName: '某某销售有限公司', issueDate: '2026-06-01' };

  it('red-counterpart 不属于自动跳过层级，kept 里两张都在', () => {
    const pos = inv({ ...base, total: 300_000, invoiceNo: '8'.repeat(20) });
    const red = inv({ ...base, total: -300_000, isRed: true, invoiceNo: '9'.repeat(20) });
    const r = findDuplicates([pos, red]);

    expect(isAutoDropLevel('red-counterpart')).toBe(false);
    expect(r.kept.sort()).toEqual([pos.id, red.id].sort());
    // 配对里的「保留方」应该是原票，而不是红冲票
    const pair = r.groups.find((g) => g.level === 'red-counterpart')!;
    expect(pair.keep).toBe(pos.id);
  });
});

// ---------------------------------------------------------------------------
// 边界：缺金额 / 标记与金额方向冲突
// ---------------------------------------------------------------------------

describe('边界：红冲票缺金额', () => {
  const noAmount = inv({ isRed: true, sellerName: '甲' });

  it('计数但金额不虚增，missingAmount 计一次', () => {
    const s = summarizeBatch([noAmount]);
    expect(s.redCount).toBe(1);
    expect(s.redTotal).toBe(0);
    expect(s.amountTotal).toBe(0);
    expect(s.missingAmount).toBe(1);
    expect(s.count).toBe(1);
  });

  it('文案说明「金额未识别」，而不是写 -¥0.00', () => {
    const text = summaryText(summarizeBatch([noAmount]));
    expect(text).toContain('红冲 1 张');
    expect(text).toContain('金额未识别');
    expect(text).not.toContain('-¥0.00');
  });

  it('缺金额的红冲不参与凑票，但会出现在 excludedRed 里', () => {
    const ok = inv({ total: 100_000 });
    const r = chooseInvoices([ok, noAmount], 100_000);
    expect(r.picked.map((i) => i.id)).toEqual([ok.id]);
    expect(r.excludedRed.map((i) => i.id)).toEqual([noAmount.id]);
    expect(r.sum).toBe(100_000);
  });
});

describe('边界：标了红冲但金额是正数', () => {
  const signLost = inv({ isRed: true, total: 500_000 });

  it('汇总按负数抵扣，且「红冲抵扣额」与合计方向一致', () => {
    const s = summarizeBatch([signLost]);
    expect(s.amountTotal).toBe(-500_000);
    expect(s.redCount).toBe(1);
    expect(s.redTotal).toBe(500_000);
    expect(s.byKind[0]!.total).toBe(-500_000);
    expect(summaryText(s)).toContain('-¥5,000.00');
  });

  it('校验给 warn（标红冲 + 正金额是矛盾信号）', () => {
    const issues = validateInvoice(signLost);
    expect(issues.some((i) => i.code === 'red-invoice' && i.level === 'warn')).toBe(true);
  });

  it('凑票排除它，理由可显示', () => {
    const r = chooseInvoices([signLost, inv({ total: 500_000 })], 500_000);
    expect(r.excludedRed).toHaveLength(1);
    expect(r.picked).toHaveLength(1);
    expect(r.sum).toBe(500_000);
  });
});

describe('人工校正的三态（isRed: true / false / null）', () => {
  it('false 覆盖负数金额的推断，汇总不再当红冲抵扣', () => {
    const corrected = applyCorrection(inv({ total: -500_000 }), { isRed: false });
    expect(corrected.isRed).toBe(false);
    expect(isRedInvoice(corrected)).toBe(false);
    const s = summarizeBatch([corrected]);
    expect(s.redCount).toBe(0);
    expect(s.redTotal).toBe(0);
    // 人工确认不是红冲 → 按票面金额（-5000）如实计入，不再单列「红冲抵扣」
    expect(s.amountTotal).toBe(-500_000);
    expect(summaryText(s)).not.toContain('红冲');
  });

  it('true 标在正数金额上会真的参与抵扣', () => {
    const corrected = applyCorrection(inv({ total: 500_000 }), { isRed: true });
    expect(summarizeBatch([corrected]).amountTotal).toBe(-500_000);
  });

  it('null 清掉标记，回到按金额推断', () => {
    const cleared = applyCorrection(inv({ total: -500_000, isRed: false }), { isRed: null });
    expect(cleared.isRed).toBeUndefined();
    expect(summarizeBatch([cleared]).redCount).toBe(1);
  });

  it('校正不改其它字段', () => {
    const before = inv({ total: -500_000, sellerName: '某公司', invoiceNo: '123' });
    const after = applyCorrection(before, { isRed: false });
    expect(after.sellerName).toBe('某公司');
    expect(after.invoiceNo).toBe('123');
    expect(after.total).toBe(-500_000);
  });
});

// ---------------------------------------------------------------------------
// 来源：XML / 票面字样（文字层 + OCR）
// ---------------------------------------------------------------------------

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

describe('来源 1：XML 金额为负', () => {
  it('isRed + provenance.derived + red-invoice issue', async () => {
    const outcome = await parseInvoiceFile({
      id: 'xml-red',
      fileName: 'red.xml',
      data: new TextEncoder().encode(NEGATIVE_XML),
      sha256: 'xml-red',
    });
    const e = outcome.invoice;
    expect(e.total).toBe(-5558);
    expect(isRedInvoice(e)).toBe(true);
    expect(e.isRed).toBe(true);
    expect(e.provenance.isRed?.source).toBe('derived');
    expect(e.issues.some((i) => i.code === 'red-invoice')).toBe(true);
  });

  it('正数 XML 不写 isRed（「没判过」不能写成「不是」）', async () => {
    const outcome = await parseInvoiceFile({
      id: 'xml-ok',
      fileName: 'ok.xml',
      data: new TextEncoder().encode(NEGATIVE_XML.replace(/-/g, '')),
      sha256: 'xml-ok',
    });
    expect(outcome.invoice.isRed).toBeUndefined();
    expect(isRedInvoice(outcome.invoice)).toBe(false);
    expect(outcome.invoice.issues.filter((i) => i.code === 'red-invoice')).toEqual([]);
  });
});

describe('来源 2：票面「红字 / 红冲」字样', () => {
  it('PDF 文字层抽出 isRed=true（金额漏了负号也认）', () => {
    const page = buildPageText(0, 595, 842, [
      { text: '增值税电子普通发票（红字）', x: 40, y: 40, width: 240, height: 12 },
      { text: '价税合计（小写）¥100.00', x: 40, y: 300, width: 200, height: 12 },
    ]);
    expect(fieldsOf(page).fields.isRed).toBe(true);
  });

  it('OCR 分支同样认「红冲」（走的是图片分支的提前 return）', async () => {
    const ocrPages: OcrPageInput[] = [
      {
        width: 595,
        height: 397,
        tokens: [
          { text: '电子发票（红冲）', x: 220, y: 20, width: 160, height: 9 },
          { text: '发票号码：', x: 60, y: 39, width: 60, height: 9 },
          { text: '12345678901234567890', x: 120, y: 39, width: 160, height: 9 },
          { text: '开票日期：', x: 60, y: 57, width: 60, height: 9 },
          { text: '2026年06月19日', x: 120, y: 57, width: 112, height: 9 },
          { text: '价税合计（小写）¥55.58', x: 40, y: 286, width: 200, height: 9 },
        ],
      },
    ];
    const outcome = await parseInvoiceFile({
      id: 'img-red',
      fileName: 'scan.png',
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]),
      sha256: 'img-red',
      ocrPages,
    });
    expect(outcome.invoice.isRed).toBe(true);
    expect(isRedInvoice(outcome.invoice)).toBe(true);
    expect(outcome.invoice.issues.some((i) => i.code === 'red-invoice')).toBe(true);
  });

  it('票面写「红字」但金额是正数时，标记保留（不被金额符号推翻）', async () => {
    const ocrPages: OcrPageInput[] = [
      {
        width: 595,
        height: 397,
        tokens: [
          { text: '电子发票（红字）', x: 220, y: 20, width: 160, height: 9 },
          { text: '价税合计（小写）¥55.58', x: 40, y: 286, width: 200, height: 9 },
        ],
      },
    ];
    const outcome = await parseInvoiceFile({
      id: 'img-red2',
      fileName: 'scan.png',
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]),
      sha256: 'img-red2',
      ocrPages,
    });
    expect(outcome.invoice.isRed).toBe(true);
    expect(summarizeBatch([outcome.invoice]).amountTotal).toBe(-5558);
  });
});

describe('解析时机：PDF 分支提前 return 时也做红冲收尾', () => {
  it('没有文字层的 PDF + 二维码金额为负 → isRed', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    const bytes = new Uint8Array(await pdf.save());

    const outcome = await parseInvoiceFile({
      id: 'pdf-qr-red',
      fileName: 'blank.pdf',
      data: bytes,
      sha256: 'pdf-qr-red',
      qrPayload: '01,32,,12345678901234567890,-55.58,20260619,,300A',
    });

    expect(outcome.invoice.total).toBe(-5558);
    expect(outcome.invoice.isRed).toBe(true);
    expect(outcome.invoice.provenance.isRed?.source).toBe('derived');
    expect(outcome.invoice.issues.some((i) => i.code === 'red-invoice')).toBe(true);
  });
});
