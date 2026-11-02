/**
 * 曾经的缺陷，现在的回归（N-01）。
 *
 * 这两个用例在实现修好之前是**失败**的，现在钉住修复后的口径：
 *
 *   D-3 校验：`isRed=true` 且**不含税金额**为正、价税合计缺省时也要给 red-invoice warn
 *       （汇总已经按 -5000 抵扣了，校验不能装作没看见）。
 *   D-4 导出：导出表的「合计」行必须与 `summarizeBatch` 的净额口径一致，
 *       不能同一批票给出两个合计数。
 */

import { describe, expect, it } from 'vitest';

import { buildExportTable } from '../src/export/invoices';
import { summarizeBatch } from '../src/export/summary';
import type { Invoice } from '../src/model/invoice';
import { validateInvoice } from '../src/validate/index';

let seq = 0;
function inv(over: Partial<Invoice> = {}): Invoice {
  seq += 1;
  return {
    id: `gap-${seq}`,
    fileName: `gap-${seq}.pdf`,
    fileSize: 1,
    sha256: `gap-${seq}`,
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

describe('D-3 校验漏报：红冲标记 + 正数的不含税金额', () => {
  it('标了红冲、价税合计缺省、不含税金额为正 → 应给 red-invoice warn', () => {
    const i = inv({ isRed: true, amount: 500_000, tax: 0 });
    // 汇总已经把它当负数抵扣了
    expect(summarizeBatch([i]).amountTotal).toBe(-500_000);
    // 校验却不说一句话
    const red = validateInvoice(i).filter((issue) => issue.code === 'red-invoice');
    expect(red.some((issue) => issue.level === 'warn')).toBe(true);
  });
});

describe('D-4 导出合计与汇总口径不一致', () => {
  it('红冲（正数金额）与普通票的导出台计应等于净额', () => {
    const signLost = inv({ isRed: true, total: 500_000 });
    const normal = inv({ total: 300_000 });

    const table = buildExportTable([signLost, normal], { fields: ['total'] });
    const summary = summarizeBatch([signLost, normal]);

    // 汇总口径：-5000 + 3000 = -2000（元）
    expect(summary.amountTotal).toBe(-200_000);
    // 导出台计（元）：应与汇总一致，而不是 +8000
    expect(table.totals?.[0]).toBe(-2_000);
  });
});
