/**
 * 校正表单 → 补丁 的回归。
 *
 * 盯的是四件事，任何一条错了都会留下脏数据：
 * 1. **只提交改过的字段** —— 否则整张票会被贴上「手工填写」，解析结果被抹平；
 * 2. **清空 = null**，不是「留旧值」；
 * 3. 金额按整数「分」走，解析不了要**报错**而不是当 0；
 * 4. 多页票的「打印哪些页」与 `skipPages` 的互补关系，以及不能一页都不留。
 */

import { describe, expect, it } from 'vitest';

import type { Invoice } from '@invoice-tool/core';
import { applyCorrection } from '@invoice-tool/core';

import { diffPatch, printPagesOf, toForm } from './correctForm';

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'x',
    fileName: 'x.pdf',
    fileSize: 0,
    sha256: 'sha',
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

describe('校正表单：差分', () => {
  it('什么都没改 → 空补丁（不会给整张票盖「手工填写」）', () => {
    const inv = invoice({
      invoiceNo: '12345678',
      sellerName: '甲公司',
      total: 11300,
      items: [{ name: '餐饮服务', amount: 11300 }],
      provenance: { invoiceNo: { source: 'qr', confidence: 0.95 } },
    });
    const { patch, errors } = diffPatch(toForm(inv), inv);
    expect(errors).toEqual([]);
    expect(patch).toEqual({});
  });

  it('只改一个字段 → 补丁里只有那个字段', () => {
    const inv = invoice({ sellerName: '甲', invoiceNo: '12345678' });
    const form = { ...toForm(inv), sellerName: '乙' };
    expect(diffPatch(form, inv).patch).toEqual({ sellerName: '乙' });
  });

  it('清空 → null（三态里的「确实没有」）', () => {
    const inv = invoice({ tax: 1300, totalInWords: '壹佰元整' });
    const { patch } = diffPatch({ ...toForm(inv), tax: '   ', totalInWords: '' }, inv);
    expect(patch).toEqual({ tax: null, totalInWords: null });
  });

  it('金额按整数「分」提交，且与原文一致时不提交', () => {
    const inv = invoice({ amount: 10000, tax: 1300, total: 11300 });
    expect(diffPatch(toForm(inv), inv).patch).toEqual({});
    expect(diffPatch({ ...toForm(inv), total: '113.01' }, inv).patch).toEqual({ total: 11301 });
  });

  it('金额有千分位也认', () => {
    const inv = invoice({});
    expect(diffPatch({ ...toForm(inv), total: '1,234.56' }, inv).patch).toEqual({ total: 123456 });
  });

  it('金额看不懂就报错，且**不**写进补丁（不能静默当 0 元）', () => {
    const inv = invoice({ total: 11300 });
    const { patch, errors } = diffPatch({ ...toForm(inv), total: '12.345' }, inv);
    expect(patch.total).toBeUndefined();
    expect(errors.join()).toContain('价税合计');
  });

  it('日期格式不对就报错', () => {
    const inv = invoice({});
    const { errors } = diffPatch({ ...toForm(inv), issueDate: '2026/01/31' }, inv);
    expect(errors.join()).toContain('YYYY-MM-DD');
  });
});

describe('校正表单：明细', () => {
  it('明细整行替换，空字段不写成空串', () => {
    const inv = invoice({ items: [{ name: '旧' }] });
    const { patch } = diffPatch(
      { ...toForm(inv), items: [{ ...toForm(inv).items[0]!, name: '餐饮', amount: '113.00' }] },
      inv,
    );
    expect(patch.items).toEqual([{ name: '餐饮', amount: 11300 }]);
  });

  it('明细一行不动时不提交', () => {
    const inv = invoice({ items: [{ name: '餐饮', quantity: 2, unitPrice: 5000, amount: 10000 }] });
    expect(diffPatch(toForm(inv), inv).patch.items).toBeUndefined();
  });

  it('明细金额看不懂时点名到具体行', () => {
    const inv = invoice({ items: [] });
    const row = { ...toForm(inv), items: [{ ...toForm(inv).items[0] ?? { name: '', spec: '', unit: '', quantity: '', unitPrice: '', amount: '', taxRate: '' }, name: '餐饮', amount: '十块' }] };
    const { errors } = diffPatch(row, inv);
    expect(errors.join()).toContain('明细 1');
  });
});

describe('校正表单：打印哪些页', () => {
  it('取消勾第 2 页 → skipPages 收下它（0 基）', () => {
    const inv = invoice({ pageCount: 3 });
    const form = { ...toForm(inv), pages: [0, 2] };
    expect(diffPatch(form, inv).patch.skipPages).toEqual([1]);
  });

  it('页数没变时不提交', () => {
    const inv = invoice({ pageCount: 2, skipPages: [0] });
    expect(diffPatch(toForm(inv), inv).patch.skipPages).toBeUndefined();
    expect(printPagesOf(inv)).toEqual([1]);
  });

  it('一页都不勾时不提交（那等于把这行删掉，不是校正）', () => {
    const inv = invoice({ pageCount: 2 });
    expect(diffPatch({ ...toForm(inv), pages: [] }, inv).patch.skipPages).toBeUndefined();
  });
});

describe('校正表单：与内核拼起来能用', () => {
  it('差分出来的补丁交给 applyCorrection，字段与出处都对', () => {
    const inv = invoice({
      invoiceNo: '11112222',
      checkCode: '123456',
      provenance: { invoiceNo: { source: 'ocr', confidence: 0.6 } },
    });
    const { patch } = diffPatch(
      { ...toForm(inv), invoiceNo: '33334444', sellerName: '甲公司' },
      inv,
    );
    const next = applyCorrection(inv, patch);
    expect(next.invoiceNo).toBe('33334444');
    expect(next.sellerName).toBe('甲公司');
    expect(next.provenance.invoiceNo).toEqual({ source: 'manual', confidence: 1 });
    expect('checkCode' in next).toBe(false); // 号码改了，旧校验码作废
  });
});
