/**
 * 「裁掉白边」的内容边界探测。
 *
 * ⚠️ 一条安全边界：**只有一页的票才裁**。
 * 多页票的各页内容边界可能不一样（第 1 页有票头、第 2 页是明细），
 * 用同一个裁剪框去套所有页，会**把某一页的内容裁掉** —— 那比留白边严重得多。
 */

import type { Box } from './box';
import type { IntakeItem } from './intake';
import { sourcePage, sourcePages } from './pages';
import { CROP_TIMEOUT_MS, withTimeout } from './timeout';

export async function detectBoxFor(item: IntakeItem): Promise<Box | undefined> {
  if (item.data.byteLength === 0) return undefined;
  // 多页票不裁（见文件头说明）
  if (sourcePages(item).length !== 1) return undefined;

  const { detectContentBox, detectImageContentBox } = await import('./raster');
  const work =
    item.visual === 'pdf'
      ? detectContentBox(item.data, sourcePage(item, 0))
      : item.visual === 'image'
        ? detectImageContentBox(item.data)
        : Promise.resolve(undefined);
  try {
    // 探测要渲染整页，后台标签页里会被限流 → 给个上限，超时就当不裁
    return await withTimeout(work, CROP_TIMEOUT_MS, '白边探测');
  } catch (err) {
    console.warn('[crop] 探测内容边界失败，按不裁处理：', err);
  }
  return undefined;
}
