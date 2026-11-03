/**
 * 「这张票印不成票面」的判定。
 *
 * 单独一个文件，是为了让 UI **在不加载 pdf-lib 的情况下**就能提前判断
 * （`pages/MergePrint` 里 `lib/print` 是动态 import 的，pdf-lib 有几百 KB，
 * 不该为了「画一条横幅」把它拖进首屏）。
 *
 * 背景：数电票的 OFD / XML 里只有结构化数据，没有票面图像。早先的实现在
 * 合成打印 PDF 时**静默**给它们画一张信息卡 —— 用户拿到的纸上是一张小卡片，
 * 直到贴报销单才发现「这不是发票」。现在任何降级都必须先说出口。
 */

import type { IntakeItem } from './intake';

/**
 * 为什么没印成票面。
 *
 * 三种是**不同性质**的事，别合并成一句「打不出来」：
 * - `no-visual`：票根本不是图像（数电票 OFD / XML）。已知且必然，提前告知即可。
 * - `empty`：解析失败或文件是空的，卡片上的字段多半也是空的。
 * - `embed-failed`：是 PDF 但没嵌进去（加密 / 损坏 / pdf-lib 不支持的写法）。
 *   这是意外，用户多半要勾上「老打印机兼容」重打一次。
 */
export type FallbackReason = 'no-visual' | 'empty' | 'embed-failed';

export interface PrintFallback {
  id: string;
  fileName: string;
  reason: FallbackReason;
}

/** 给 UI 用的一句话解释 */
export const FALLBACK_HINT: Record<FallbackReason, string> = {
  'no-visual': 'OFD / XML 只有结构化数据，没有票面图像',
  empty: '文件是空的或解析失败',
  'embed-failed': '票面没能嵌进打印 PDF（试试勾上「老打印机兼容」）',
};

/**
 * 这张票**注定**印不成票面原样吗（不用真的合成一遍就能答）。
 *
 * 打印前就能回答，才谈得上「提前告知」：等 PDF 合成完再说，纸张已经出去了。
 * 返回 `null` 表示应该能正常印。
 */
export function fallbackReasonOf(item: IntakeItem): FallbackReason | null {
  if (item.visual === 'none') return 'no-visual';
  if (item.data.byteLength === 0) return 'empty';
  return null;
}

/** 一批票里注定要退化成信息卡的那些（横幅、打印前确认都用它） */
export function previewFallbacks(items: readonly IntakeItem[]): PrintFallback[] {
  const out: PrintFallback[] = [];
  for (const item of items) {
    const reason = fallbackReasonOf(item);
    if (reason) out.push({ id: item.id, fileName: item.invoice.fileName, reason });
  }
  return out;
}
