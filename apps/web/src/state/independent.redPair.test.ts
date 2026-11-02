/**
 * 独立验收：查重的「红冲配对」不能进自动跳过名单（N-01 · 外壳侧）。
 *
 * 内核说 `isAutoDropLevel('red-counterpart') === false` 只是**内核的**结论；
 * 用户看到的是 store 算出来的 `skipped`。这两个必须一致，
 * 否则界面上两张票都在、但打印时一张被静默滤掉。
 */

import type { Invoice } from '@invoice-tool/core';
import { describe, expect, it } from 'vitest';

import type { IntakeItem } from '../lib/intake';
import { initialState, reducer } from './store';

let seq = 0;
function invoice(over: Partial<Invoice> = {}): Invoice {
  seq += 1;
  return {
    id: `ir-${seq}`,
    fileName: `ir-${seq}.pdf`,
    fileSize: 1,
    sha256: `ir-${seq}`,
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

function item(inv: Invoice): IntakeItem {
  return { id: inv.id, invoice: inv, data: new Uint8Array(), visual: 'none', embeddable: false, width: 0, height: 0 };
}

const base = { sellerName: '某某销售有限公司', issueDate: '2026-06-01' };
const positive = invoice({ ...base, total: 500_000, invoiceNo: '1'.repeat(20) });
const red = invoice({ ...base, total: -500_000, isRed: true, invoiceNo: '2'.repeat(20) });

describe('store：自动查重不改动红冲配对', () => {
  it('一正一负配成红冲对 → skipped 里没有它们', () => {
    const state = reducer(initialState(), { type: 'intake/done', items: [item(positive), item(red)] });
    expect(state.prefs.autoDedupe).toBe(true);
    expect(state.dedupeGroups.some((g) => g.level === 'red-counterpart')).toBe(true);
    expect(state.skipped).toEqual([]);
  });

  it('对照组：真重复（同 sha256）仍然会被跳过 —— 证明上一条不是空断言', () => {
    const a = invoice({ total: 100_000, sha256: 'same-hash' });
    const b = invoice({ total: 100_000, sha256: 'same-hash' });
    const state = reducer(initialState(), { type: 'intake/done', items: [item(a), item(b)] });
    expect(state.skipped).toHaveLength(1);
    expect(state.dedupeGroups.some((g) => g.level === 'file')).toBe(true);
  });

  it('「撤销跳过」之后再算一遍，红冲对仍然不跳过', () => {
    const withDup = reducer(initialState(), { type: 'intake/done', items: [item(positive), item(red)] });
    const undone = reducer(withDup, { type: 'dedupe/undo' });
    expect(undone.skipped).toEqual([]);
    expect(undone.dedupeGroups.some((g) => g.level === 'red-counterpart')).toBe(true);
  });
});
