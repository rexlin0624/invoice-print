/**
 * 排版：把 N 张发票摆到 A4 上，输出**唯一一份几何**。
 *
 * 为什么要有 LayoutSpec：参考项目把排版算了两套（JS 一套给预览、Rust 一套给导出），
 * 还要求五处同步，是 bug 温床。这里只输出一次的几何（pt，**y 轴向下**，左上为原点），
 * 再由两个极薄适配器分别转成 CSS 与 PDF 坐标系。
 */

import type { Invoice, InvoiceKind } from '../model/invoice';
import { INVOICE_KIND_GROUP, printablePages } from '../model/invoice';

export const MM = 72 / 25.4;
export const mm = (v: number): number => v * MM;

/** A4，pt */
export const A4 = { width: mm(210), height: mm(297) } as const;

export type PerPage = 1 | 2 | 4;
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type Margin = 'narrow' | 'normal' | 'wide';

const MARGIN: Record<Margin, number> = {
  narrow: mm(8),
  normal: mm(12),
  wide: mm(20),
};

/** 页边距的实际点数。导出给「校准测试页」用 —— 那边要画出票能占的范围，不能自己再算一遍 */
export const MARGIN_PT: Record<Margin, number> = MARGIN;

/** 槽位之间的间隙 */
const GAP = mm(3);

export interface LayoutSettings {
  perPage: PerPage;
  paper: 'A4';
  orientation: Orientation;
  margin: Margin;
  /** 火车票 / 行程单单独成页（尺寸不同，混排会很难看） */
  groupTickets: boolean;
  /** 专票与普票分开 */
  separateTaxType: boolean;
  /** 允许旋转 90° 以更好利用纸张（发票会侧躺） */
  allowRotation: boolean;
  /** 裁切线 */
  cutLines: boolean;
  /** 页脚页码 */
  pageNumbers: boolean;
  /** 老打印机兼容：输出成图片 PDF（本内核不实现栅格化，由外壳处理） */
  rasterCompat: boolean;
  /** 裁掉白边。内核不实现裁剪，只负责把「裁剪后的尺寸」当成排版依据 */
  cropWhitespace: boolean;
  /** 黑白打印（栅格化 + 阈值化），省墨、也更容易被老打印机吃下去 */
  blackWhite: boolean;
  /**
   * 打印偏移（mm，正值 = 往右 / 往下）。
   *
   * 为什么需要它：打印机的实际成像区常常与纸边有几毫米的差，纸的走位也会偏；
   * 排出来的版面没错，打出来却偏出裁切线。让用户用「校准测试页」量出偏差、
   * 填进这里，比让他去改打印机的驱动设置靠谱得多。
   */
  offsetXMm: number;
  offsetYMm: number;
}

/** 校准偏移的上限（mm）。超过这个数说明不是校准问题，是选错纸型了 */
export const OFFSET_LIMIT_MM = 20;

/** 偏移归一化：非数字/越界一律夹到合法范围，绝不让脏设置把票推出纸外 */
export function clampOffsetMm(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-OFFSET_LIMIT_MM, Math.min(OFFSET_LIMIT_MM, Math.round(n * 10) / 10));
}

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  perPage: 2,
  paper: 'A4',
  orientation: 'auto',
  margin: 'normal',
  groupTickets: true,
  separateTaxType: false,
  allowRotation: false,
  // 默认与设计稿一致：裁切线开、页脚页码关
  cutLines: true,
  pageNumbers: false,
  rasterCompat: false,
  cropWhitespace: false,
  blackWhite: false,
  offsetXMm: 0,
  offsetYMm: 0,
};

/**
 * 把来路不明的设置收敛成合法值。
 *
 * 输入可能是：上一个版本写的 localStorage、用户手改过的 JSON、或者别的页面塞进来的半截对象。
 * 早先这里只是 `{ ...默认, ...存下来的 }` —— 于是 `perPage: 3`（甚至 `perPage: "4"`）
 * 会一路走到排版里，`gridFor` 落到「不是 1 也不是 2」的分支，一张 A4 只摆一张票，
 * 而用户看到的设置写着「每页 4 张」。**读设置的地方必须收敛，而不是信它。**
 */
export function normalizeLayoutSettings(raw: unknown): LayoutSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.some((option) => option === value) ? (value as T) : fallback;
  const flag = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  /**
   * 只认数字与「长得像数字的字符串」（`<select>` 的 value 是字符串）。
   * 刻意不用 `Number(value)` 一把梭：`Number(true)` 是 1、`Number([])` 是 0 ——
   * 那会让「开关被写进了 perPage 这个键」变成一张 A4 只摆一张票。
   */
  const num = (value: unknown, fallback: number): number => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return fallback;
  };
  const d = DEFAULT_LAYOUT_SETTINGS;

  return {
    perPage: pick(num(source.perPage, d.perPage), [1, 2, 4] as const, d.perPage) as PerPage,
    paper: 'A4',
    orientation: pick(source.orientation, ['auto', 'portrait', 'landscape'] as const, d.orientation),
    margin: pick(source.margin, ['narrow', 'normal', 'wide'] as const, d.margin),
    groupTickets: flag(source.groupTickets, d.groupTickets),
    separateTaxType: flag(source.separateTaxType, d.separateTaxType),
    allowRotation: flag(source.allowRotation, d.allowRotation),
    cutLines: flag(source.cutLines, d.cutLines),
    pageNumbers: flag(source.pageNumbers, d.pageNumbers),
    rasterCompat: flag(source.rasterCompat, d.rasterCompat),
    cropWhitespace: flag(source.cropWhitespace, d.cropWhitespace),
    blackWhite: flag(source.blackWhite, d.blackWhite),
    offsetXMm: clampOffsetMm(source.offsetXMm),
    offsetYMm: clampOffsetMm(source.offsetYMm),
  };
}

export interface LayoutItem {
  id: string;
  kind: InvoiceKind;
  /** 内容原始尺寸（pt） */
  width: number;
  height: number;
  /**
   * 这张票有几页。**大于 1 时每页各占一个槽位** ——
   * 多页票（医疗票的明细页、带清单的票）不能只打第一页，那会漏内容。
   * 页面尺寸按 `width/height` 统一处理（同一张票的各页尺寸通常一致）。
   * 默认 1。
   */
  pages?: number;
}

export interface Slot {
  /** 对应 LayoutItem 的 id */
  id: string;
  /** 这是该票的第几页（0 起）。单页票恒为 0。 */
  page: number;
  col: number;
  row: number;
  /** 槽位矩形（pt，y 向下） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 内容放在槽位内的左上角（已居中） */
  contentX: number;
  contentY: number;
  /** 内容缩放后尺寸 */
  contentW: number;
  contentH: number;
  scale: number;
  rotation: 0 | 90;
}

export interface LayoutPage {
  index: number;
  width: number;
  height: number;
  slots: Slot[];
}

export interface LayoutSpec {
  paperWidth: number;
  paperHeight: number;
  orientation: 'portrait' | 'landscape';
  margin: number;
  perPage: PerPage;
  pages: LayoutPage[];
  pageCount: number;
  /** 没排进去的（理论上不该有） */
  unplaced: string[];
}

interface Grid {
  cols: number;
  rows: number;
}

function gridFor(perPage: PerPage, orientation: 'portrait' | 'landscape'): Grid {
  if (perPage === 1) return { cols: 1, rows: 1 };
  if (perPage === 2) return orientation === 'portrait' ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 };
  return { cols: 2, rows: 2 };
}

/** 内容在槽位里的最佳摆放（不旋转 / 旋转 90° 取更优） */
function fit(
  item: { width: number; height: number },
  cellW: number,
  cellH: number,
  allowRotation: boolean,
): { scale: number; rotation: 0 | 90; w: number; h: number } {
  const w = item.width > 0 ? item.width : A4.width;
  const h = item.height > 0 ? item.height : A4.height;

  const s0 = Math.min(cellW / w, cellH / h);
  let best = { scale: s0, rotation: 0 as 0 | 90, w: w * s0, h: h * s0 };

  if (allowRotation) {
    const s90 = Math.min(cellW / h, cellH / w);
    if (s90 > best.scale * 1.0001) {
      best = { scale: s90, rotation: 90, w: h * s90, h: w * s90 };
    }
  }
  return best;
}

/** 给定朝向后，所有票的平均缩放比（越大越不浪费纸） */
function averageScale(
  items: readonly LayoutItem[],
  perPage: PerPage,
  orientation: 'portrait' | 'landscape',
  margin: number,
  allowRotation: boolean,
): number {
  const paper = orientation === 'portrait' ? A4 : { width: A4.height, height: A4.width };
  const grid = gridFor(perPage, orientation);
  const usableW = paper.width - margin * 2 - GAP * (grid.cols - 1);
  const usableH = paper.height - margin * 2 - GAP * (grid.rows - 1);
  const cellW = usableW / grid.cols;
  const cellH = usableH / grid.rows;
  if (cellW <= 0 || cellH <= 0) return 0;
  if (items.length === 0) return 0;
  let sum = 0;
  for (const it of items) sum += fit(it, cellW, cellH, allowRotation).scale;
  return sum / items.length;
}

/** 「自动方向」= 选平均缩放更大的那个朝向 */
export function chooseOrientation(
  items: readonly LayoutItem[],
  settingsInput: Partial<LayoutSettings> = {},
): 'portrait' | 'landscape' {
  const settings = normalizeLayoutSettings(settingsInput);
  if (settings.orientation !== 'auto') return settings.orientation;
  const margin = MARGIN[settings.margin];
  const p = averageScale(items, settings.perPage, 'portrait', margin, settings.allowRotation);
  const l = averageScale(items, settings.perPage, 'landscape', margin, settings.allowRotation);
  // 平手时用竖版（更符合「A4 打印」的直觉）
  return l > p * 1.02 ? 'landscape' : 'portrait';
}

/** 分组：不同尺寸的票各自成页 */
function groupItems(items: readonly LayoutItem[], settings: LayoutSettings): LayoutItem[][] {
  const sameGroup = (a: LayoutItem, b: LayoutItem): boolean => {
    if (settings.groupTickets && INVOICE_KIND_GROUP[a.kind] !== INVOICE_KIND_GROUP[b.kind]) return false;
    if (settings.separateTaxType) {
      const sp = (k: InvoiceKind): boolean => k === 'vat-special';
      if (sp(a.kind) !== sp(b.kind)) return false;
    }
    return true;
  };

  const groups: LayoutItem[][] = [];
  for (const it of items) {
    const g = groups.find((grp) => sameGroup(grp[0]!, it));
    if (g) g.push(it);
    else groups.push([it]);
  }
  return groups;
}

export function buildLayout(
  items: readonly LayoutItem[],
  settingsInput: Partial<LayoutSettings> = {},
): LayoutSpec {
  const settings = normalizeLayoutSettings(settingsInput);
  const margin = MARGIN[settings.margin];
  // 校准偏移：整页的槽位一起平移（裁切线跟着走），票本身仍居中在槽里
  const dx = mm(settings.offsetXMm);
  const dy = mm(settings.offsetYMm);

  if (items.length === 0) {
    return {
      paperWidth: A4.width,
      paperHeight: A4.height,
      orientation: 'portrait',
      margin,
      perPage: settings.perPage,
      pages: [],
      pageCount: 0,
      unplaced: [],
    };
  }

  const orientation = chooseOrientation(items, settings);
  const paper = orientation === 'portrait' ? A4 : { width: A4.height, height: A4.width };
  const grid = gridFor(settings.perPage, orientation);

  const slotW = (paper.width - margin * 2 - GAP * (grid.cols - 1)) / grid.cols;
  const slotH = (paper.height - margin * 2 - GAP * (grid.rows - 1)) / grid.rows;

  const groups = groupItems(items, settings);
  const pages: LayoutPage[] = [];

  for (const group of groups) {
    // 先把「票」展开成「页」：多页票的每一页各占一个槽位
    const units: Array<{ item: LayoutItem; page: number }> = [];
    for (const item of group) {
      const count = Math.max(1, Math.floor(item.pages ?? 1));
      for (let p = 0; p < count; p++) units.push({ item, page: p });
    }

    for (let start = 0; start < units.length; start += settings.perPage) {
      const chunk = units.slice(start, start + settings.perPage);
      const slots: Slot[] = [];
      chunk.forEach((unit, i) => {
        const item = unit.item;
        const col = i % grid.cols;
        const row = Math.floor(i / grid.cols);
        if (row >= grid.rows) return; // 理论上不会发生（chunk 长度 == perPage）
        const x = margin + col * (slotW + GAP) + dx;
        const y = margin + row * (slotH + GAP) + dy;
        const f = fit(item, slotW, slotH, settings.allowRotation);
        slots.push({
          id: item.id,
          page: unit.page,
          col,
          row,
          x,
          y,
          w: slotW,
          h: slotH,
          contentX: x + (slotW - f.w) / 2,
          contentY: y + (slotH - f.h) / 2,
          contentW: f.w,
          contentH: f.h,
          scale: f.scale,
          rotation: f.rotation,
        });
      });
      pages.push({ index: pages.length, width: paper.width, height: paper.height, slots });
    }
  }

  return {
    paperWidth: paper.width,
    paperHeight: paper.height,
    orientation,
    margin,
    perPage: settings.perPage,
    pages,
    pageCount: pages.length,
    unplaced: [],
  };
}

/** 便捷：从 Invoice 数组构造排版输入 */
export function layoutItemsFrom(invoices: readonly Invoice[], sizeOf?: (inv: Invoice) => { width: number; height: number }): LayoutItem[] {
  return invoices.map((inv) => {
    const size = sizeOf?.(inv) ?? { width: A4.width, height: mm(140) };
    return {
      id: inv.id,
      kind: inv.kind,
      width: size.width,
      height: size.height,
      // 明细页已被剔除，槽位数按「实际要打的页数」算
      pages: printablePages(inv).length,
    };
  });
}
