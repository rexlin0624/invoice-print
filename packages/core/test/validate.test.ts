import { describe, expect, it } from 'vitest';

import type { Invoice } from '../src/model/invoice';
import { checkTaxId, isValidUscc, usccCheckChar } from '../src/validate/uscc';
import { validateInvoice, worstLevel } from '../src/validate/index';

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

describe('统一社会信用代码校验位', () => {
  it('真实税号应通过', () => {
    expect(usccCheckChar('9131000000000011M')).toBe('K');
    expect(isValidUscc('9131000000000011MK')).toBe(true);
    expect(checkTaxId('9131000000000011MK')).toBe('valid');
    expect(checkTaxId('9144000000000011MN')).toBe('valid');
  });

  it('改一位就该失败', () => {
    expect(isValidUscc('9131000000000011MX')).toBe(false);
    expect(checkTaxId('9131000000000011MX')).toBe('invalid');
  });

  it('老纳税识别号不做判定（不是 USCC）', () => {
    expect(checkTaxId('123456789012345')).toBe('unknown');
    expect(checkTaxId('9131000000000012PP')).toBe('invalid'); // 18 位且在字符集内 → 要判
    expect(checkTaxId(undefined)).toBe('unknown');
    expect(checkTaxId('')).toBe('unknown');
  });
});

describe('validateInvoice', () => {
  it('金额平衡通过时无 error', () => {
    const issues = validateInvoice(invoice({ amount: 5258, tax: 300, total: 5558 }));
    expect(issues.filter((i) => i.code === 'amount-mismatch')).toHaveLength(0);
  });

  it('金额不平衡时给 error，并指向 total', () => {
    const issues = validateInvoice(invoice({ amount: 5258, tax: 300, total: 5559 }));
    const hit = issues.find((i) => i.code === 'amount-mismatch');
    expect(hit).toBeDefined();
    expect(hit!.level).toBe('error');
    expect(hit!.field).toBe('total');
    expect(hit!.message).toContain('¥55.59');
  });

  it('大写与小写不一致', () => {
    const issues = validateInvoice(
      invoice({ total: 5558, totalInWords: '伍拾伍圆伍角捌分' }),
    );
    expect(issues.filter((i) => i.code === 'capital-mismatch')).toHaveLength(0);

    const bad = validateInvoice(invoice({ total: 5558, totalInWords: '贰佰圆整' }));
    expect(bad.find((i) => i.code === 'capital-mismatch')).toBeDefined();
  });

  it('缺字段用 warn 且带 field', () => {
    const issues = validateInvoice(invoice());
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('missing-field');
    expect(issues.find((i) => i.field === 'invoiceNo')).toBeDefined();
    expect(worstLevel(issues)).toBe('warn');
  });

  it('发票号码形态', () => {
    expect(validateInvoice(invoice({ invoiceNo: '12345678901234567890' })).some((i) => i.code === 'invoice-no-shape')).toBe(false);
    expect(validateInvoice(invoice({ invoiceNo: '12345678' })).some((i) => i.code === 'invoice-no-shape')).toBe(false);
    expect(validateInvoice(invoice({ invoiceNo: '123' })).some((i) => i.code === 'invoice-no-shape')).toBe(true);
  });

  it('抬头与设置不一致时提示', () => {
    const issues = validateInvoice(invoice({ buyerName: '某某测试甲有限公司' }), {
      companyName: '某某有限公司',
    });
    expect(issues.some((i) => i.message.includes('与设置'))).toBe(true);
  });

  it('没设置公司抬头/税号时不该提示不一致', () => {
    const full = invoice({
      buyerName: '某某测试甲有限公司',
      buyerTaxId: '9131000000000011MK',
    });
    for (const options of [{}, { companyName: '' }, { companyName: '   ', companyTaxId: '' }]) {
      const issues = validateInvoice(full, options);
      expect(issues.some((i) => i.message.includes('与设置'))).toBe(false);
    }
  });

  it('抬头前后空格不算不一致', () => {
    const issues = validateInvoice(invoice({ buyerName: '某某有限公司' }), {
      companyName: '  某某有限公司  ',
    });
    expect(issues.some((i) => i.message.includes('与设置'))).toBe(false);
  });

  it('超过报销期限', () => {
    const issues = validateInvoice(invoice({ issueDate: '2026-01-01' }), {
      today: '2026-10-16',
      reimburseWindowDays: 180,
    });
    expect(issues.some((i) => i.message.includes('超过报销期限'))).toBe(true);
  });
});

describe('购销方交叉校验', () => {
  it('两侧名称相同 → 提示可能读串了', () => {
    const issues = validateInvoice(
      invoice({ sellerName: '甲公司', buyerName: '甲公司', invoiceNo: '12345678901234567890' }),
    );
    expect(issues.map((i) => i.code)).toContain('party-suspect');
  });

  it('两侧税号相同 → 提示可能读串了', () => {
    const issues = validateInvoice(
      invoice({ sellerTaxId: '9131000000000011MK', buyerTaxId: '9131000000000011MK' }),
    );
    expect(issues.map((i) => i.code)).toContain('party-suspect');
  });

  it('正常票不误报', () => {
    const issues = validateInvoice(
      invoice({
        invoiceNo: '12345678901234567890',
        issueDate: '2026-06-19',
        sellerName: '某某测试乙有限公司',
        buyerName: '某某测试甲有限公司',
        sellerTaxId: '9144000000000011MN',
        buyerTaxId: '9131000000000011MK',
      }),
    );
    expect(issues.filter((i) => i.code === 'party-suspect')).toEqual([]);
  });

  it('只给一侧时不比较（缺字段由 missing-field 管）', () => {
    const issues = validateInvoice(invoice({ sellerName: '甲公司' }));
    expect(issues.filter((i) => i.code === 'party-suspect')).toEqual([]);
  });
});
