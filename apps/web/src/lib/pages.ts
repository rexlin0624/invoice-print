/**
 * 「票」与「页」之间的换算。
 *
 * 一份文件可能有多页（多页发票、医疗票带明细页），也可能指定了裁剪框。
 * 排版与打印都按**「第几张要打的页」**说话（`Slot.page` 就是这个序号），
 * 由这里统一换算回源文件里的真实页号 —— 于是「剔除明细页」只需要维护内核里那一份
 * `invoice.skipPages`，不必让排版、预览、打印各自记得哪些页不打印。
 */

import type { LayoutItem } from '@invoice-tool/core';
import { printablePages } from '@invoice-tool/core';

import type { Box } from './box';
import type { IntakeItem } from './intake';

/** 该票实际要打印的源文件页下标 */
export function sourcePages(item: IntakeItem): number[] {
  return printablePages(item.invoice);
}

/** 第 `ordinal` 张要打的页 → 源文件页下标 */
export function sourcePage(item: IntakeItem, ordinal: number): number {
  const pages = sourcePages(item);
  return pages[ordinal] ?? pages[0] ?? 0;
}

/** 排版用的内容尺寸：裁了白边就用裁剪框的尺寸 */
export function effectiveSize(item: IntakeItem): { width: number; height: number } {
  const crop: Box | null | undefined = item.crop;
  if (crop && crop.w > 0 && crop.h > 0) return { width: crop.w, height: crop.h };
  return { width: item.width, height: item.height };
}

/**
 * 构造排版输入。
 *
 * 两个细节：
 * - 页数用 `printablePages().length`（明细页已被剔除），不是 `pageCount`
 * - 有裁剪框时**关掉旋转**：裁剪后再旋转，槽位与裁剪区的换算会绕，
 *   收益却只是省一点纸；真需要省纸的用户把「裁掉白边」关掉即可
 */
export function layoutItems(items: readonly IntakeItem[]): LayoutItem[] {
  return items.map((item) => {
    const size = effectiveSize(item);
    return {
      id: item.id,
      kind: item.invoice.kind,
      width: size.width,
      height: size.height,
      pages: sourcePages(item).length,
    };
  });
}

/** 有票被裁过白边 —— 调用方据此关掉旋转（见上面说明） */
export function anyCropped(items: readonly IntakeItem[]): boolean {
  // `null` = 探测过但决定不裁，不算「裁过」（见 IntakeItem.crop 的三态说明）
  return items.some((it) => it.crop !== undefined && it.crop !== null);
}
