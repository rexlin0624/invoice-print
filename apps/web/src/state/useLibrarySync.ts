/**
 * 把「已打印 / 已报销」的标记落进本机库。
 *
 * 为什么用 effect 而不是在点击处直接写库：标记可能来自好几条路径
 * （打印按钮、打印后的 toast、库页手动改），放在一处声明式同步，
 * 就不会出现「某个入口忘了写库」。写入是幂等的，重复标记不会重复占空间。
 */

import { useEffect, useRef } from 'react';

import type { LibraryMark } from '../lib/library';
import { remember } from '../lib/library';
import { pushBackup } from '../lib/libraryBackup';
import { useStore } from './store';
import { useLibraryLoad } from './useLibrary';

export function useLibrarySync(): void {
  const { state } = useStore();
  useLibraryLoad();
  /** 本次会话已经写过的「id@状态」，避免每次 state 变化都重写一遍 */
  const written = useRef<Set<string>>(new Set());

  const { items, marks, prefs } = state;

  useEffect(() => {
    if (!prefs.saveLibrary) return;

    const batches: Record<LibraryMark, Array<{ name: string; data: Uint8Array; item: (typeof items)[number] }>> = {
      printed: [],
      reimbursed: [],
    };

    for (const item of items) {
      const mark = marks[item.id];
      if (!mark) continue;
      const key = `${item.id}@${mark}`;
      if (written.current.has(key)) continue;
      written.current.add(key);
      batches[mark].push({ name: item.invoice.fileName, data: item.data, item });
    }

    // 先写「已打印」，再写「已报销」（remember 里状态只升不降，顺序其实无所谓）
    for (const mark of ['printed', 'reimbursed'] as const) {
      const batch = batches[mark];
      if (batch.length === 0) continue;
      void remember(
        batch.map(({ name, data, item }) => ({
          sha256: item.invoice.sha256,
          invoice: item.invoice,
          bytes: data,
          fileName: name,
          fileSize: item.invoice.fileSize,
          visual: item.visual,
        })),
        mark,
      ).then(() => pushBackup());
    }
  }, [items, marks, prefs.saveLibrary]);
}
