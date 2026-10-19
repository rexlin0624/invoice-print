/**
 * 批次汇总与 CSV 公式注入防护的回归。
 *
 * 汇总最容易错的是「缺金额」：当 0 元加进去，合计看着是对的，账却是漏的。
 */

import { describe, expect, it } from 'vitest';

import type { Invoice } from '../src/model/invoice';
import { guardFormula } from '../src/export/invoices';
import { recognitionRate, summarizeBatch, summaryText } from '../src/export/summary';

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

describe('批次汇总', () => {
  it('空批次不炸，也不出 NaN', () => {
    const s = summarizeBatch([]);
    expect(s.count).toBe(0);
    expect(recognitionRate(s)).toBe(0);
    expect(summaryText(s)).toContain('没有可统计的发票');
  });

  it('金额合计只统计拿得到金额的票，缺的单独计数', () => {
    const s = summarizeBatch([
      invoice({ total: 11300 }),
      invoice({ amount: 10000, tax: 1300 }), // 用不含税 + 税额兜
      invoice({ total: undefined }), // 没金额
    ]);
    expect(s.amountTotal).toBe(22600);
    expect(s.missingAmount).toBe(1);
    expect(s.count).toBe(3);
  });

  it('识别率按「有发票号码」算', () => {
    const s = summarizeBatch([
      invoice({ invoiceNo: '12345678901234567890' }),
      invoice({ invoiceNo: '10987654321098765432' }),
      invoice({ invoiceNo: undefined }),
      invoice({ invoiceNo: undefined }),
    ]);
    expect(s.recognized).toBe(2);
    expect(s.missingNo).toBe(2);
    expect(recognitionRate(s)).toBe(0.5);
  });

  it('按票种分组，张数多的在前，金额按票种分开合计', () => {
    const s = summarizeBatch([
      invoice({ kind: 'train', total: 5000 }),
      invoice({ kind: 'vat-special', total: 100000 }),
      invoice({ kind: 'train', total: 6000 }),
    ]);
    expect(s.byKind[0]).toMatchObject({ kind: 'train', label: '火车票', count: 2, total: 11000 });
    expect(s.byKind[1]).toMatchObject({ kind: 'vat-special', count: 1, total: 100000 });
  });

  it('日期范围取最早与最晚，没日期的票不参与', () => {
    const s = summarizeBatch([
      invoice({ issueDate: '2026-03-05' }),
      invoice({ issueDate: '2026-01-28' }),
      invoice({ issueDate: undefined }),
    ]);
    expect(s.dateFrom).toBe('2026-01-28');
    expect(s.dateTo).toBe('2026-03-05');
  });

  it('销售方按不重名计数', () => {
    const s = summarizeBatch([
      invoice({ sellerName: '甲' }),
      invoice({ sellerName: '甲' }),
      invoice({ sellerName: '乙' }),
      invoice({ sellerName: undefined }),
    ]);
    expect(s.sellers).toBe(2);
  });

  it('汇总文本是对账能用的，且缺号码会被点名', () => {
    const s = summarizeBatch([
      invoice({ invoiceNo: '12345678901234567890', total: 11300, issueDate: '2026-01-05' }),
      invoice({ invoiceNo: undefined, total: 5000, issueDate: '2026-01-06' }),
    ]);
    const text = summaryText(s, { title: '发票汇总' });
    expect(text).toContain('发票汇总（2 张）');
    expect(text).toContain('已识别发票号码：1 张');
    expect(text).toContain('163.00');
    expect(text).toContain('2026-01-05 ~ 2026-01-06');
    expect(text).toContain('1 张没有发票号码');
  });
});

describe('CSV 公式注入中和', () => {
  it('危险开头加前导单引号', () => {
    expect(guardFormula('=HYPERLINK("http://x","点我")')).toMatch(/^'=/);
    expect(guardFormula('+1+1')).toMatch(/^'\+/);
    expect(guardFormula('-2+3')).toMatch(/^'-/);
    expect(guardFormula('@SUM(A1)')).toMatch(/^'@/);
  });

  it('正常内容不动（中文名、数字串、普通字母）', () => {
    expect(guardFormula('上海某某贸易有限公司')).toBe('上海某某贸易有限公司');
    expect(guardFormula('12345678901234567890')).toBe('12345678901234567890');
    expect(guardFormula('A-1 号发票')).toBe('A-1 号发票');
  });
});
