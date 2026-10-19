/**
 * 人工校正的回归。
 *
 * 这里测的不是「界面点了保存」而是三态语义本身 —— 它是整个校正功能的合同：
 * 没提到的不动、`null` 清空、有值写死。除此之外还有两条容易被改坏的规矩：
 * 号码改了要丢旧校验码、针对被校正字段的解析问题要跟着消失。
 */

import { describe, expect, it } from 'vitest';

import type { Invoice } from '../src/model/invoice';
import {
  applyCorrection,
  correctedFields,
  invoiceTotal,
  isCorrected,
  makeIssue,
  printablePages,
  SOURCE_CONFIDENCE,
} from '../src/model/invoice';

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'x',
    fileName: 'x.pdf',
    fileSize: 0,
    sha256: '',
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

describe('人工校正：三态语义', () => {
  it('没提到的字段不动', () => {
    const before = invoice({ sellerName: '甲公司', invoiceNo: '12345678' });
    const after = applyCorrection(before, { buyerName: '乙公司' });
    expect(after.sellerName).toBe('甲公司');
    expect(after.invoiceNo).toBe('12345678');
    expect(after.buyerName).toBe('乙公司');
  });

  it('null 清空字段（而不是留着旧值）', () => {
    const before = invoice({ sellerName: '读错了的公司', tax: 1300 });
    const after = applyCorrection(before, { sellerName: null, tax: null });
    expect('sellerName' in after).toBe(false);
    expect('tax' in after).toBe(false);
  });

  it('空串等于清空，且两侧空白会被去掉', () => {
    const after = applyCorrection(invoice({ sellerName: '甲' }), {
      sellerName: '   ',
      buyerName: '  乙公司  ',
    });
    expect('sellerName' in after).toBe(false);
    expect(after.buyerName).toBe('乙公司');
  });

  it('金额按整数「分」写入，字符串不参与', () => {
    const after = applyCorrection(invoice(), { amount: 10000, tax: 1300, total: 11300 });
    expect(after.total).toBe(11300);
    expect(invoiceTotal(after)).toBe(11300);
  });

  it('不改原对象（纯函数）', () => {
    const before = invoice({ sellerName: '甲' });
    const snapshot = JSON.stringify(before);
    applyCorrection(before, { sellerName: '乙' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('人工校正：出处', () => {
  it('改过的字段标成 manual（可信度 1）', () => {
    const after = applyCorrection(invoice(), { invoiceNo: '10987654321098765432', total: 11300 });
    expect(after.provenance.invoiceNo).toEqual({
      source: 'manual',
      confidence: SOURCE_CONFIDENCE.manual,
    });
    expect(after.provenance.total?.source).toBe('manual');
  });

  it('没改的字段保留原来的出处', () => {
    const before = invoice({
      sellerName: '甲',
      provenance: { sellerName: { source: 'qr', confidence: 0.95 } },
    });
    const after = applyCorrection(before, { buyerName: '乙' });
    expect(after.provenance.sellerName).toEqual({ source: 'qr', confidence: 0.95 });
  });

  it('清空字段时把出处也一起删掉（别留「来自二维码」指向不存在的东西）', () => {
    const before = invoice({
      sellerName: '甲',
      provenance: { sellerName: { source: 'ocr', confidence: 0.6 } },
    });
    const after = applyCorrection(before, { sellerName: null });
    expect(after.provenance.sellerName).toBeUndefined();
  });

  it('isCorrected / correctedFields 认得出人工改过', () => {
    const plain = invoice({ provenance: { sellerName: { source: 'qr', confidence: 0.95 } } });
    expect(isCorrected(plain)).toBe(false);

    const fixed = applyCorrection(plain, { invoiceNo: '12345678' });
    expect(isCorrected(fixed)).toBe(true);
    expect(correctedFields(fixed)).toEqual(['invoiceNo']);
  });
});

describe('人工校正：号码与校验码', () => {
  it('号码改了 → 旧校验码作废', () => {
    const before = invoice({ invoiceNo: '11112222', invoiceCode: '011002100311', checkCode: '123456' });
    const after = applyCorrection(before, { invoiceNo: '33334444' });
    expect(after.invoiceNo).toBe('33334444');
    expect('checkCode' in after).toBe(false);
    expect(after.invoiceCode).toBe('011002100311'); // 代码不动
  });

  it('号码没变（含只差空白）→ 校验码保留', () => {
    const before = invoice({ invoiceNo: '11112222', checkCode: '123456' });
    expect(applyCorrection(before, { invoiceNo: '11112222' }).checkCode).toBe('123456');
    expect(applyCorrection(before, { invoiceNo: ' 11112222 ' }).checkCode).toBe('123456');
  });

  it('同一批里给了新校验码就听调用方的', () => {
    const before = invoice({ invoiceNo: '11112222', checkCode: '123456' });
    const after = applyCorrection(before, { invoiceNo: '33334444', checkCode: '654321' });
    expect(after.checkCode).toBe('654321');
  });

  it('第一次补录号码（原来没有）不该算「号码变了」，但确实会留下号码', () => {
    const before = invoice({ checkCode: '123456' });
    const after = applyCorrection(before, { invoiceNo: '12345678' });
    expect(after.invoiceNo).toBe('12345678');
  });
});

describe('人工校正：问题列表', () => {
  it('针对被校正字段的解析问题被清掉（人工已经核过了）', () => {
    const before = invoice({
      invoiceNo: '11112222',
      issues: [
        makeIssue('qr-mismatch', 'warn', '二维码与票面不一致，请人工核对', 'invoiceNo'),
        makeIssue('no-text-layer', 'warn', '这份 PDF 没有文字层'),
        makeIssue('low-confidence', 'info', '销售方归属靠推断', 'sellerName'),
      ],
    });
    const after = applyCorrection(before, { invoiceNo: '33334444' });
    expect(after.issues.map((i) => i.code)).toEqual(['no-text-layer', 'low-confidence']);
  });

  it('没动这些字段时问题原样保留', () => {
    const before = invoice({
      issues: [makeIssue('qr-mismatch', 'warn', '不一致', 'total')],
    });
    const after = applyCorrection(before, { sellerName: '甲' });
    expect(after.issues).toHaveLength(1);
  });
});

describe('人工校正：明细与页选择', () => {
  it('明细整体替换', () => {
    const before = invoice({ items: [{ name: '旧' }] });
    const after = applyCorrection(before, { items: [{ name: '餐饮服务', amount: 10000 }] });
    expect(after.items).toEqual([{ name: '餐饮服务', amount: 10000 }]);
    expect(after.provenance.items?.source).toBe('manual');
  });

  it('明细可以清空成空数组（“这张票没有明细”）', () => {
    const after = applyCorrection(invoice({ items: [{ name: '旧' }] }), { items: [] });
    expect(after.items).toEqual([]);
  });

  it('页选择影响实际要打印的页', () => {
    const after = applyCorrection(invoice({ pageCount: 3, skipPages: [2] }), { skipPages: [1] });
    expect(printablePages(after)).toEqual([0, 2]);
  });
});

describe('发票金额口径', () => {
  it('优先价税合计', () => {
    expect(invoiceTotal({ total: 11300, amount: 10000, tax: 1300 })).toBe(11300);
  });

  it('没有价税合计时用不含税 + 税额', () => {
    expect(invoiceTotal({ amount: 10000, tax: 1300 })).toBe(11300);
  });

  it('只拿到一半就返回 undefined —— 缺金额绝不能当 0 元', () => {
    expect(invoiceTotal({ amount: 10000 })).toBeUndefined();
    expect(invoiceTotal({})).toBeUndefined();
  });
});
