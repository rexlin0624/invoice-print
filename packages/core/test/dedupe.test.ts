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
