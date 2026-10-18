/**
 * 凑票（选票组和）的回归。
 *
 * 重点是**边界**：额度场景不能超（`under`），对账场景要最接近（`nearest`），
 * 以及预算用满时必须返回一个可用的解而不是空手而归。
 */

import { describe, expect, it } from 'vitest';

import { chooseInvoices, combinable, groupTotals } from '../src/combine/index';
import type { Invoice } from '../src/model/invoice';

/** 只有 total 参与凑数，其余字段随便给 —— 用最少的噪音构造变量 */
function inv(id: string, total: number, extra: Partial<Invoice> = {}): Invoice {
  return {
    id,
    fileName: `${id}.pdf`,
    fileSize: 1,
    sha256: id.padEnd(8, '0'),
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    total,
    ...extra,
  };
}

describe('combinable', () => {
  it('没有价税合计的票不参与凑数', () => {
    const list = [
      inv('a', 1000),
      { ...inv('b', 0), total: undefined },
      { ...inv('c', 0), total: 0 },
    ];
    expect(combinable(list).map((i) => i.id)).toEqual(['a']);
  });
});

describe('chooseInvoices — under（额度场景）', () => {
  it('能凑到正好等于目标', () => {
    const pool = [inv('a', 3000), inv('b', 2000), inv('c', 1500), inv('d', 500)];
    const r = chooseInvoices(pool, 3500, { mode: 'under' });
    expect(r.sum).toBe(3500);
    expect(r.exact).toBe(true);
    expect(r.picked.map((i) => i.id).sort()).toEqual(['a', 'd']);
  });

  it('凑不齐时取不超目标的最大和', () => {
    const pool = [inv('a', 3000), inv('b', 3000), inv('c', 1000)];
    const r = chooseInvoices(pool, 5000, { mode: 'under' });
    expect(r.sum).toBe(4000);
    expect(r.sum).toBeLessThanOrEqual(5000);
  });

  it('绝不超目标（哪怕只差一分）', () => {
    const pool = [inv('a', 10001), inv('b', 9999)];
    const r = chooseInvoices(pool, 10000, { mode: 'under' });
    expect(r.sum).toBe(9999);
    expect(r.diff).toBeLessThan(0);
  });

  it('容差内算对上', () => {
    const pool = [inv('a', 9999)];
    expect(chooseInvoices(pool, 10000, { mode: 'under' }).within).toBe(false);
    expect(chooseInvoices(pool, 10000, { mode: 'under', tolerance: 1 }).within).toBe(true);
  });

  it('maxCount 限制张数', () => {
    const pool = [inv('a', 500), inv('b', 500), inv('c', 500), inv('d', 500)];
    const r = chooseInvoices(pool, 2000, { mode: 'under', maxCount: 2 });
    expect(r.picked).toHaveLength(2);
    expect(r.sum).toBe(1000);
  });

  it('目标为 0 或没有可用票时，返回空而不是抛异常', () => {
    expect(chooseInvoices([inv('a', 100)], 0).picked).toEqual([]);
    expect(chooseInvoices([], 100).picked).toEqual([]);
    expect(chooseInvoices([], 100).diff).toBe(-100);
  });
});

describe('chooseInvoices — nearest（对账场景）', () => {
  it('允许超过目标，取绝对差额最小的', () => {
    const pool = [inv('a', 6000), inv('b', 4500)];
    const r = chooseInvoices(pool, 5000, { mode: 'nearest' });
    expect(r.sum).toBe(4500); // |5000-4500| = 500 < |5000-6000| = 1000
    expect(r.diff).toBe(-500);
  });

  it('宁可选一张略超的，也不要差很多', () => {
    const pool = [inv('a', 5100), inv('b', 100)];
    const r = chooseInvoices(pool, 5000, { mode: 'nearest' });
    expect(r.sum).toBe(5100);
    expect(r.exact).toBe(false);
  });
});

describe('chooseInvoices — 健壮性', () => {
  it('两百张票也能毫秒级给出结果', () => {
    const pool = Array.from({ length: 200 }, (_, i) => inv(`i${i}`, 100 + ((i * 37) % 5000)));
    const t0 = Date.now();
    const r = chooseInvoices(pool, 1_000_000, { mode: 'under' });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.sum).toBeLessThanOrEqual(1_000_000);
    expect(r.sum).toBeGreaterThan(0);
  });

  it('结果稳定：同样的输入给同样的解', () => {
    const pool = [inv('a', 1000), inv('b', 700), inv('c', 300), inv('d', 250)];
    const first = chooseInvoices(pool, 1300, { mode: 'under' });
    const second = chooseInvoices(pool, 1300, { mode: 'under' });
    expect(first.picked.map((i) => i.id)).toEqual(second.picked.map((i) => i.id));
  });

  it('金额相同时按日期排，保证可复现', () => {
    const pool = [
      inv('later', 1000, { issueDate: '2026-06-02' }),
      inv('earlier', 1000, { issueDate: '2026-06-01' }),
    ];
    const r = chooseInvoices(pool, 1000, { mode: 'under', maxCount: 1 });
    expect(r.picked[0]!.id).toBe('earlier');
  });
});

describe('groupTotals', () => {
  it('按销售方分组', () => {
    const pool = [
      inv('a', 1000, { sellerName: '甲' }),
      inv('b', 2000, { sellerName: '甲' }),
      inv('c', 500, { sellerName: '乙' }),
    ];
    const rows = groupTotals(pool, 'seller');
    expect(rows).toEqual([
      { key: '甲', count: 2, total: 3000 },
      { key: '乙', count: 1, total: 500 },
    ]);
  });

  it('按月分组', () => {
    const pool = [inv('a', 1000, { issueDate: '2026-06-01' }), inv('b', 1, { issueDate: '2026-07-01' })];
    expect(groupTotals(pool, 'month').map((r) => r.key)).toEqual(['2026-06', '2026-07']);
  });
});
