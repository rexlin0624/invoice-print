import { describe, expect, it } from 'vitest';

import type { LayoutItem } from '../src/layout/index';
import {
  A4,
  DEFAULT_LAYOUT_SETTINGS,
  buildLayout,
  chooseOrientation,
  mm,
  normalizeLayoutSettings,
} from '../src/layout/index';

/** 数电票：210×140 mm */
const STANDARD: LayoutItem = { id: 'a', kind: 'vat-general', width: mm(210), height: mm(140) };
const ITEMS = (n: number, over: Partial<LayoutItem> = {}): LayoutItem[] =>
  Array.from({ length: n }, (_, i) => ({ ...STANDARD, id: `i${i}`, ...over }));

describe('自动方向', () => {
  it('1 张横版发票 → 横向更省纸', () => {
    expect(chooseOrientation([STANDARD], { perPage: 1 })).toBe('landscape');
  });

  it('2 张横版发票 → 竖向（上下各一）', () => {
    const { orientation } = buildLayout(ITEMS(2), { perPage: 2 });
    expect(orientation).toBe('portrait');
  });

  it('4 张横版发票 → 横向（2×2 几乎铺满）', () => {
    const { orientation } = buildLayout(ITEMS(4), { perPage: 4 });
    expect(orientation).toBe('landscape');
  });

  it('显式指定方向时不被覆盖', () => {
    const { orientation } = buildLayout(ITEMS(4), { perPage: 4, orientation: 'portrait' });
    expect(orientation).toBe('portrait');
  });
});

describe('分页与槽位', () => {
  it('每页 2 张，5 张票 → 3 页', () => {
    const spec = buildLayout(ITEMS(5), { perPage: 2 });
    expect(spec.pageCount).toBe(3);
    expect(spec.pages[0]!.slots).toHaveLength(2);
    expect(spec.pages[2]!.slots).toHaveLength(1);
  });

  it('每页 4 张，4 张票 → 1 页 4 槽', () => {
    const spec = buildLayout(ITEMS(4), { perPage: 4 });
    expect(spec.pageCount).toBe(1);
    expect(spec.pages[0]!.slots).toHaveLength(4);
  });

  it('内容不超出纸张，也不超出槽位', () => {
    for (const perPage of [1, 2, 4] as const) {
      const spec = buildLayout(ITEMS(6), { perPage });
      for (const page of spec.pages) {
        for (const slot of page.slots) {
          expect(slot.contentX).toBeGreaterThanOrEqual(spec.margin - 0.001);
          expect(slot.contentY).toBeGreaterThanOrEqual(spec.margin - 0.001);
          expect(slot.contentX + slot.contentW).toBeLessThanOrEqual(page.width - spec.margin + 0.001);
          expect(slot.contentY + slot.contentH).toBeLessThanOrEqual(page.height - spec.margin + 0.001);
          expect(slot.contentW).toBeLessThanOrEqual(slot.w + 0.001);
          expect(slot.contentH).toBeLessThanOrEqual(slot.h + 0.001);
        }
      }
    }
  });

  it('保持内容宽高比', () => {
    const spec = buildLayout(ITEMS(2), { perPage: 2 });
    const slot = spec.pages[0]!.slots[0]!;
    const srcRatio = STANDARD.width / STANDARD.height;
    expect(slot.contentW / slot.contentH).toBeCloseTo(srcRatio, 5);
  });

  it('槽位在纸张内且互不重叠', () => {
    const spec = buildLayout(ITEMS(4), { perPage: 4 });
    const slots = spec.pages[0]!.slots;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        const overlap =
          a.x < b.x + b.w - 0.001 &&
          b.x < a.x + a.w - 0.001 &&
          a.y < b.y + b.h - 0.001 &&
          b.y < a.y + a.h - 0.001;
        expect(overlap, `槽位 ${i} 与 ${j} 重叠`).toBe(false);
      }
    }
  });
});

describe('分组', () => {
  it('火车票单独成页', () => {
    const items: LayoutItem[] = [
      ...ITEMS(2),
      { id: 'train', kind: 'train', width: mm(180), height: mm(100) },
    ];
    const spec = buildLayout(items, { perPage: 2, groupTickets: true });
    // 2 张普票占 1 页，火车票单独 1 页
    expect(spec.pageCount).toBe(2);
    const lastPage = spec.pages[spec.pages.length - 1]!;
    expect(lastPage.slots).toHaveLength(1);
    expect(lastPage.slots[0]!.id).toBe('train');
  });

  it('关闭分组时混排', () => {
    const items: LayoutItem[] = [
      ...ITEMS(1),
      { id: 'train', kind: 'train', width: mm(180), height: mm(100) },
    ];
    const spec = buildLayout(items, { perPage: 2, groupTickets: false });
    expect(spec.pageCount).toBe(1);
    expect(spec.pages[0]!.slots).toHaveLength(2);
  });

  it('专普票分开（可选）', () => {
    const items: LayoutItem[] = [
      { id: 'g', kind: 'vat-general', width: mm(210), height: mm(140) },
      { id: 's', kind: 'vat-special', width: mm(210), height: mm(140) },
    ];
    const mixed = buildLayout(items, { perPage: 4, separateTaxType: false, groupTickets: false });
    expect(mixed.pageCount).toBe(1);
    const split = buildLayout(items, { perPage: 4, separateTaxType: true });
    expect(split.pageCount).toBe(2);
  });
});

describe('边界', () => {
  it('空输入', () => {
    const spec = buildLayout([]);
    expect(spec.pageCount).toBe(0);
    expect(spec.pages).toEqual([]);
  });

  it('纸张尺寸是 A4', () => {
    expect(A4.width).toBeCloseTo(595.28, 1);
    expect(A4.height).toBeCloseTo(841.89, 1);
  });

  it('旋转可提升填充率', () => {
    const noRotate = buildLayout(ITEMS(4), { perPage: 4, orientation: 'portrait', allowRotation: false });
    const rotate = buildLayout(ITEMS(4), { perPage: 4, orientation: 'portrait', allowRotation: true });
    expect(rotate.pages[0]!.slots[0]!.scale).toBeGreaterThan(noRotate.pages[0]!.slots[0]!.scale);
  });
});

describe('多页票（逻辑票）', () => {
  const twoPages: LayoutItem = { ...STANDARD, id: 'multi', pages: 2 };

  it('多页票的每一页各占一个槽位', () => {
    const spec = buildLayout([twoPages], { perPage: 4, orientation: 'landscape' });
    expect(spec.pageCount).toBe(1);
    expect(spec.pages[0]!.slots).toHaveLength(2);
    expect(spec.pages[0]!.slots.map((s) => s.page)).toEqual([0, 1]);
    // 两个槽位都属于同一张票
    expect(spec.pages[0]!.slots.map((s) => s.id)).toEqual(['multi', 'multi']);
  });

  it('单页票的 page 恒为 0', () => {
    const spec = buildLayout(ITEMS(2), { perPage: 2 });
    expect(spec.pages[0]!.slots.every((s) => s.page === 0)).toBe(true);
  });

  it('页数超过每页张数时会翻页，且不丢页', () => {
    const spec = buildLayout([{ ...STANDARD, id: 'm', pages: 5 }], { perPage: 2, orientation: 'portrait' });
    expect(spec.pageCount).toBe(3);
    const pages = spec.pages.flatMap((p) => p.slots.map((s) => s.page));
    expect(pages).toEqual([0, 1, 2, 3, 4]);
  });

  it('多页票的第 2 页不会被当成重复票而少打（页数参与槽位计算）', () => {
    const one = buildLayout([{ ...STANDARD, id: 'x', pages: 1 }], { perPage: 4, orientation: 'landscape' });
    const three = buildLayout([{ ...STANDARD, id: 'x', pages: 3 }], { perPage: 4, orientation: 'landscape' });
    expect(one.pages[0]!.slots).toHaveLength(1);
    expect(three.pages[0]!.slots).toHaveLength(3);
  });

  it('pages 缺失或非法时按 1 页处理', () => {
    const spec = buildLayout(
      [
        { ...STANDARD, id: 'a', pages: 0 },
        { ...STANDARD, id: 'b', pages: undefined },
      ],
      { perPage: 4, orientation: 'landscape' },
    );
    expect(spec.pages[0]!.slots).toHaveLength(2);
  });
});

describe('校准偏移', () => {
  it('正的 X/Y 把槽位往右下推，负的往左上', () => {
    const base = buildLayout(ITEMS(1), { perPage: 1, orientation: 'portrait' });
    const down = buildLayout(ITEMS(1), { perPage: 1, orientation: 'portrait', offsetXMm: 3, offsetYMm: -2 });
    expect(down.pages[0]!.slots[0]!.x - base.pages[0]!.slots[0]!.x).toBeCloseTo(mm(3), 6);
    expect(down.pages[0]!.slots[0]!.y - base.pages[0]!.slots[0]!.y).toBeCloseTo(mm(-2), 6);
  });

  it('内容跟着槽位一起走（不会只挪框不挪票）', () => {
    const spec = buildLayout(ITEMS(1), { perPage: 1, orientation: 'portrait', offsetXMm: 5 });
    const slot = spec.pages[0]!.slots[0]!;
    expect(slot.contentX - slot.x).toBeCloseTo((slot.w - slot.contentW) / 2, 6);
  });

  it('越界/脏值被夹住，不会把票推出纸外', () => {
    const spec = buildLayout(ITEMS(1), { perPage: 1, offsetXMm: 999, offsetYMm: Number.NaN });
    const slot = spec.pages[0]!.slots[0]!;
    expect(slot.x - spec.margin).toBeCloseTo(mm(20), 6);
    expect(slot.y - spec.margin).toBeCloseTo(0, 6);
  });
});

describe('设置收敛（脏 localStorage 不能进排版）', () => {
  it('未知的 perPage 回到默认 2 张', () => {
    expect(normalizeLayoutSettings({ perPage: 3 }).perPage).toBe(2);
    expect(normalizeLayoutSettings({ perPage: 2.5 }).perPage).toBe(2);
    expect(normalizeLayoutSettings({ perPage: 'abc' }).perPage).toBe(2);
    // `<select>` 里取出来的是字符串，得认
    expect(normalizeLayoutSettings({ perPage: '4' }).perPage).toBe(4);
    expect(normalizeLayoutSettings({ perPage: 4 }).perPage).toBe(4);
  });

  it('布尔值不会被 `Number()` 蒙混成 1 张/页', () => {
    expect(normalizeLayoutSettings({ perPage: true }).perPage).toBe(2);
    expect(normalizeLayoutSettings({ perPage: null }).perPage).toBe(2);
  });

  it('方向/页边距只认白名单里的值', () => {
    const s = normalizeLayoutSettings({ orientation: 'sideways', margin: 'huge' });
    expect(s.orientation).toBe('auto');
    expect(s.margin).toBe('normal');
  });

  it('布尔开关非布尔时回到默认', () => {
    expect(normalizeLayoutSettings({ cutLines: 'yes' }).cutLines).toBe(true);
    expect(normalizeLayoutSettings({ pageNumbers: 1 }).pageNumbers).toBe(false);
  });

  it('整个对象不是对象时也能拿到一份合法设置', () => {
    expect(normalizeLayoutSettings(null)).toEqual(DEFAULT_LAYOUT_SETTINGS);
    expect(normalizeLayoutSettings('乱七八糟')).toEqual(DEFAULT_LAYOUT_SETTINGS);
  });

  it('偏移保留一位小数并夹到 ±20mm', () => {
    expect(normalizeLayoutSettings({ offsetXMm: 1.234 }).offsetXMm).toBe(1.2);
    expect(normalizeLayoutSettings({ offsetYMm: -50 }).offsetYMm).toBe(-20);
  });
});
