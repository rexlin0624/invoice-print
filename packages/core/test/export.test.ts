/**
 * 导出汇总表的回归。
 *
 * 重点盯三件事：
 * 1. 20 位发票号码**绝不会**被当成数字（Excel 科学计数法会丢精度）
 * 2. 金额是数字（能合计）且是元、两位小数
 * 3. CSV 与 XLSX 用的是同一份口径（这里测的是那份口径本身）
 */

import { describe, expect, it } from 'vitest';

import type { Invoice } from '../src/model/invoice';
import {
  EXPORT_COLUMNS,
  buildExportTable,
  centsToYuan,
  guardLongDigits,
  tableToCsv,
  toLocalDateTime,
} from '../src/export/invoices';

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'x',
    fileName: 'x.pdf',
    fileSize: 0,
    sha256: 'x',
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

describe('guardLongDigits — 长数字串保护', () => {
  it('15 位以上才加 =""（发票号码 20 位）', () => {
    expect(guardLongDigits('12345678901234567890')).toBe('="12345678901234567890"');
    expect(guardLongDigits('9131000000000011MK')).toBe('9131000000000011MK');
    expect(guardLongDigits('123456789012345')).toBe('="123456789012345"');
    expect(guardLongDigits('12345678901234')).toBe('12345678901234');
    expect(guardLongDigits('2026-06-19')).toBe('2026-06-19');
  });
});

describe('centsToYuan', () => {
  it('分 → 元，两位小数', () => {
    expect(centsToYuan(5558)).toBe(55.58);
    expect(centsToYuan(1987)).toBe(19.87);
    expect(centsToYuan(100)).toBe(1);
    expect(centsToYuan(0)).toBe(0);
  });
});

describe('buildExportTable', () => {
  const a = invoice({
    id: 'a',
    invoiceNo: '12345678901234567890',
    issueDate: '2026-06-19',
    sellerName: '某某测试石油有限公司',
    total: 5558,
    amount: 5258,
    tax: 300,
    kind: 'vat-general',
  });
  const b = invoice({
    id: 'b',
    invoiceNo: '10987654321098765432',
    issueDate: '2026-06-22',
    sellerName: '某某测试乙有限公司',
    total: 1987,
    amount: 1874,
    tax: 113,
    kind: 'toll',
  });

  it('默认列包含三个金额列，顺序与列定义一致', () => {
    const table = buildExportTable([a, b]);
    expect(table.header).toEqual(['开票日期', '发票号码', '票种', '销售方', '价税合计', '不含税金额', '税额']);
    expect(table.numeric).toEqual([false, false, false, false, true, true, true]);
  });

  it('金额是数字（元），号码是字符串', () => {
    const table = buildExportTable([a, b]);
    const row = table.rows[0]!;
    expect(row[4]).toBe(55.58);
    expect(typeof row[4]).toBe('number');
    expect(row[1]).toBe('12345678901234567890');
  });

  it('合计行只累加金额列，其余留空', () => {
    const table = buildExportTable([a, b]);
    expect(table.totals).toBeDefined();
    const totals = table.totals!;
    expect(totals[4]).toBeCloseTo(75.45, 2);
    expect(totals[5]).toBeCloseTo(71.32, 2);
    expect(totals[6]).toBeCloseTo(4.13, 2);
    expect(totals[0]).toBe('合计 2 张');
    expect(totals[1]).toBeUndefined();
  });

  it('浮点求和不会跑出 0.30000000000000004 之类的尾巴', () => {
    const third = invoice({ id: 'c', total: 3 });
    const table = buildExportTable([invoice({ id: 'p', total: 1 }), invoice({ id: 'q', total: 2 }), third], {
      fields: ['total'],
    });
    expect(table.totals![0]).toBe(0.06);
  });

  it('没有金额列时不给合计行', () => {
    const table = buildExportTable([a], { fields: ['invoiceNo'] });
    expect(table.totals).toBeUndefined();
  });

  it('缺字段留空，不写 0 也不写「—」', () => {
    const table = buildExportTable([invoice({ id: 'z' })], { fields: ['invoiceNo', 'total'] });
    expect(table.rows[0]).toEqual([undefined, undefined]);
  });

  it('勾选顺序不影响列顺序（永远按列定义排）', () => {
    const t1 = buildExportTable([a], { fields: ['total', 'issueDate'] });
    const t2 = buildExportTable([a], { fields: ['issueDate', 'total'] });
    expect(t1.header).toEqual(t2.header);
    expect(t1.header).toEqual(['开票日期', '价税合计']);
  });

  it('状态列取的是 marks', () => {
    const table = buildExportTable([a, b], { fields: ['invoiceNo', 'mark'], marks: { a: 'reimbursed' } });
    expect(table.rows[0]![1]).toBe('已报销');
    expect(table.rows[1]![1]).toBeUndefined();
  });

  it('合计行的文案可换（已报销库导出时用）', () => {
    const table = buildExportTable([a], { totalsLabel: '已报销 1 张' });
    expect(table.totals![0]).toBe('已报销 1 张');
  });

  it('每一列的 field 都在列定义里（防止手写列名漂移）', () => {
    const table = buildExportTable([a], { fields: EXPORT_COLUMNS.map((c) => c.field) });
    expect(table.columns).toHaveLength(EXPORT_COLUMNS.length);
    expect(table.header).toHaveLength(EXPORT_COLUMNS.length);
  });
});

describe('toLocalDateTime', () => {
  it('输出 YYYY-MM-DD HH:mm（本地时区，补零）', () => {
    const ms = new Date(2026, 5, 19, 9, 5).getTime();
    expect(toLocalDateTime(ms)).toBe('2026-06-19 09:05');
  });
});

describe('tableToCsv', () => {
  const a = invoice({
    id: 'a',
    invoiceNo: '12345678901234567890',
    sellerName: '某某测试乙有限公司',
    total: 5558,
  });

  it('长号码写成 ="" 保护，Excel 打开是文本', () => {
    const csv = tableToCsv(buildExportTable([a], { fields: ['invoiceNo'] }));
    expect(csv).toContain('"=""12345678901234567890"""');
  });

  it('金额不加引号（Excel 才能求和）', () => {
    const csv = tableToCsv(buildExportTable([a], { fields: ['total'] }));
    expect(csv.split('\r\n')[1]).toBe('55.58');
  });

  it('逗号与引号按 RFC4180 转义', () => {
    const tricky = invoice({ id: 't', sellerName: 'A,B "C"' });
    const csv = tableToCsv(buildExportTable([tricky], { fields: ['sellerName'] }));
    expect(csv).toContain('"A,B ""C"""');
  });

  it('CRLF 行尾，最后一行不带尾巴（表头也是带引号的文本）', () => {
    const csv = tableToCsv(buildExportTable([a], { fields: ['issueDate'], includeTotals: false }));
    expect(csv).toBe('"开票日期"\r\n');
  });

  it('只勾一列金额时，合计值不会被标签覆盖', () => {
    const csv = tableToCsv(buildExportTable([a], { fields: ['total'] }));
    expect(csv.split('\r\n')[2]).toBe('55.58');
  });

  it('有 caption 时放在最前（给筛选条件留位置）', () => {
    const csv = tableToCsv(buildExportTable([a], { fields: ['total'], caption: '仅 2026 年 6 月' }));
    expect(csv.startsWith('"仅 2026 年 6 月"')).toBe(true);
  });
});

describe('CSV：公式注入与长数字串', () => {
  it('以 = + - @ 开头的文本被中和，普通文本不受影响', () => {
    const table = buildExportTable([
      invoice({ sellerName: '=HYPERLINK("http://evil","点我")' }),
      invoice({ sellerName: '上海某某贸易有限公司' }),
    ]);
    const csv = tableToCsv(table);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/"=HYPERLINK/);
    expect(csv).toContain('上海某某贸易有限公司');
  });

  it('20 位号码仍然是保护起来的文本，不会被中和成别的样子', () => {
    const table = buildExportTable([invoice({ invoiceNo: '12345678901234567890' })]);
    // 转义之后写进 CSV 的样子：Excel 打开是文本，不是 1.2346E+19
    expect(tableToCsv(table)).toContain('"=""12345678901234567890"""');
  });
});
