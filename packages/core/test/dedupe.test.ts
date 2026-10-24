import { describe, expect, it } from 'vitest';

import type { Invoice } from '../src/model/invoice';
import { findDuplicates } from '../src/dedupe/index';

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

describe('三层去重', () => {
  it('文件级：sha256 相同 → 静默跳过', () => {
    const a = inv({ sha256: 'same' });
    const b = inv({ sha256: 'same' });
    const r = findDuplicates([a, b]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.level).toBe('file');
    expect(r.kept).toHaveLength(1);
  });

  it('业务级：发票号码相同 → 合并为一张（同一张票的 PDF + OFD）', () => {
    const pdf = inv({ invoiceNo: '12345678901234567890' });
    const ofd = inv({ invoiceNo: '12345678901234567890', provenance: { invoiceNo: { source: 'ofd', confidence: 0.97 } } });
    const r = findDuplicates([pdf, ofd]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.level).toBe('invoice-no');
    expect(r.kept).toEqual([ofd.id]); // 留下结构化来源那张
    expect(r.groups[0]!.reason).toContain('12345678901234567890');
  });

  it('业务级：老票按「代码 + 号码」判定，两个都一样才确定重复', () => {
    const a = inv({ invoiceNo: '12345678', invoiceCode: '011002100311' });
    const b = inv({ invoiceNo: '12345678', invoiceCode: '011002100311' });
    const r = findDuplicates([a, b]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.level).toBe('invoice-no');
    expect(r.groups[0]!.reason).toContain('011002100311');
    expect(r.groups[0]!.reason).toContain('12345678');
    expect(r.kept).toHaveLength(1);
  });

  it('业务级：同号码但发票代码不同 → 不是重复（老票常见的撞号）', () => {
    const a = inv({ invoiceNo: '12345678', invoiceCode: '011002100311' });
    const b = inv({ invoiceNo: '12345678', invoiceCode: '044002100322' });
    const r = findDuplicates([a, b]);
    expect(r.groups).toHaveLength(0);
    expect(r.kept).toEqual([a.id, b.id]);
    expect(r.flagged).toHaveLength(0);
  });

  it('业务级：一侧缺代码时，并入同号码唯一的代码组', () => {
    const coded = inv({ invoiceNo: '12345678', invoiceCode: '011002100311' });
    const uncoded = inv({ invoiceNo: '12345678', provenance: { invoiceNo: { source: 'pdf-text', confidence: 0.85 } } });
    const r = findDuplicates([coded, uncoded]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.level).toBe('invoice-no');
    expect(r.kept).toEqual([coded.id]); // 字段更全的那张留下
  });

  it('业务级：同号码对应多个代码时，缺代码的票不猜归属、不自动删', () => {
    const a = inv({ invoiceNo: '12345678', invoiceCode: '011002100311' });
    const b = inv({ invoiceNo: '12345678', invoiceCode: '044002100322' });
    const ambiguous = inv({ invoiceNo: '12345678' });
    const r = findDuplicates([a, b, ambiguous]);
    expect(r.groups).toHaveLength(0);
    expect(r.kept).toEqual([a.id, b.id, ambiguous.id]);
    expect(r.flagged).toHaveLength(0);
  });

  it('业务级：号码/代码里的空白不影响比较', () => {
    const a = inv({ invoiceNo: '1234 5678', invoiceCode: '0110 0210 0311' });
    const b = inv({ invoiceNo: '12345678', invoiceCode: '011002100311' });
    const r = findDuplicates([a, b]);
    expect(r.groups).toHaveLength(1);
    expect(r.kept).toHaveLength(1);
  });

  it('OCR 撞号：只标记，不自动删', () => {
    const clean = inv({
      invoiceNo: '12345678901234567890',
      provenance: { invoiceNo: { source: 'pdf-text', confidence: 0.85 } },
    });
    const ocr = inv({
      invoiceNo: '12345678901234567890',
      provenance: { invoiceNo: { source: 'ocr', confidence: 0.6 } },
    });
    const r = findDuplicates([clean, ocr]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.level).toBe('ocr-invoice-no');
    expect(r.groups[0]!.keep).toBe(clean.id);
    expect(r.groups[0]!.drop).toEqual([ocr.id]);
    expect(r.kept).toEqual([clean.id, ocr.id]); // 两张都保留
    expect(r.flagged).toEqual([ocr.id]);
  });

  it('OCR 撞号：建议保留的优先选可信来源那张', () => {
    const ocr = inv({
      invoiceNo: '12345678901234567890',
      provenance: { invoiceNo: { source: 'ocr', confidence: 0.6 } },
    });
    const clean = inv({
      invoiceNo: '12345678901234567890',
      provenance: { invoiceNo: { source: 'pdf-text', confidence: 0.85 } },
    });
    const r = findDuplicates([ocr, clean]);
    expect(r.groups[0]!.keep).toBe(clean.id);
    expect(r.groups[0]!.drop).toEqual([ocr.id]);
    expect(r.kept).toEqual([ocr.id, clean.id]); // 只是建议，实际都保留
  });

  it('OCR 撞号：代码来自 OCR 时同样只标记', () => {
    const clean = inv({
      invoiceNo: '12345678',
      invoiceCode: '011002100311',
      provenance: {
        invoiceNo: { source: 'pdf-text', confidence: 0.85 },
        invoiceCode: { source: 'ocr', confidence: 0.6 },
      },
    });
    const other = inv({ invoiceNo: '12345678', invoiceCode: '011002100311' });
    const r = findDuplicates([clean, other]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.level).toBe('ocr-invoice-no');
    expect(r.kept).toHaveLength(2);
    expect(r.flagged).toHaveLength(1);
  });

  it('文件级仍优先：同一个文件即使号码来自 OCR 也只留一张', () => {
    const a = inv({
      sha256: 'same',
      invoiceNo: '12345678901234567890',
      provenance: { invoiceNo: { source: 'ocr', confidence: 0.6 } },
    });
    const b = inv({
      sha256: 'same',
      invoiceNo: '12345678901234567890',
      provenance: { invoiceNo: { source: 'ocr', confidence: 0.6 } },
    });
    const r = findDuplicates([a, b]);
    expect(r.groups.map((g) => g.level)).toEqual(['file']);
    expect(r.kept).toHaveLength(1);
    expect(r.flagged).toHaveLength(0);
  });

  it('OCR 撞号不会再被疑似层重复标记（同号不是「号码不同」）', () => {
    const a = inv({
      invoiceNo: '1'.repeat(20),
      sellerName: '某某公司',
      total: 5558,
      issueDate: '2026-06-19',
      provenance: { invoiceNo: { source: 'ocr', confidence: 0.6 } },
    });
    const b = inv({
      invoiceNo: '1'.repeat(20),
      sellerName: '某某公司',
      total: 5558,
      issueDate: '2026-06-19',
      provenance: { invoiceNo: { source: 'ocr', confidence: 0.6 } },
    });
    const r = findDuplicates([a, b]);
    expect(r.groups.map((g) => g.level)).toEqual(['ocr-invoice-no']);
    expect(r.kept).toHaveLength(2);
    expect(r.flagged).toHaveLength(1);
  });

  it('疑似级：销售方+金额+日期相同但号码不同 → 只标记不删', () => {
    const a = inv({ invoiceNo: '11111111111111111111', sellerName: '某某公司', total: 5558, issueDate: '2026-06-19' });
    const b = inv({ invoiceNo: '22222222222222222222', sellerName: '某某公司', total: 5558, issueDate: '2026-06-19' });
    const r = findDuplicates([a, b]);
    const suspected = r.groups.find((g) => g.level === 'suspected');
    expect(suspected).toBeDefined();
    expect(r.kept).toHaveLength(2); // 两张都保留
    expect(r.flagged).toEqual([b.id]);
  });

  it('三要素缺一就不算疑似', () => {
    const a = inv({ invoiceNo: '1'.repeat(20), sellerName: 'A', total: 100 });
    const b = inv({ invoiceNo: '2'.repeat(20), sellerName: 'A', total: 100 });
    expect(findDuplicates([a, b]).groups).toHaveLength(0);
  });

  it('没有重复时返回全部', () => {
    const r = findDuplicates([inv({ invoiceNo: '1'.repeat(20) }), inv({ invoiceNo: '2'.repeat(20) })]);
    expect(r.groups).toHaveLength(0);
    expect(r.kept).toHaveLength(2);
    expect(r.flagged).toHaveLength(0);
  });

  it('文件级去重不会覆盖业务级判断', () => {
    const a = inv({ sha256: 'same', invoiceNo: '1'.repeat(20) });
    const b = inv({ sha256: 'same', invoiceNo: '1'.repeat(20) });
    const c = inv({ invoiceNo: '1'.repeat(20) });
    const r = findDuplicates([a, b, c]);
    expect(r.kept).toHaveLength(1);
    // 文件级 1 组 + 业务级 1 组
    expect(r.groups.map((g) => g.level)).toEqual(['file', 'invoice-no']);
  });
});
