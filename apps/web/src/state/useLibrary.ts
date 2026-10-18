/**
 * 已报销库的 React 绑定。
 *
 * 用 `useSyncExternalStore` 而不是自己写 useState + useEffect：
 * 库里可能同时有「导入完成后自动记账」和「库页手动改状态」两条写入路径，
 * 订阅模型能保证两边看到的是同一份数据，也不会出现 tearing。
 */

import { useEffect, useSyncExternalStore } from 'react';

import type { LibraryRecord } from '../lib/library';
import { currentLibrary, libraryVersion, loadLibrary, subscribeLibrary } from '../lib/library';

/** 只订阅版本号，拿到的是当前快照（同步、稳定引用） */
export function useLibrary(): LibraryRecord[] {
  const version = useSyncExternalStore(subscribeLibrary, libraryVersion, () => 0);
  void version;
  return currentLibrary();
}

/** 首次挂载时把库读进内存 */
export function useLibraryLoad(): void {
  useEffect(() => {
    void loadLibrary();
  }, []);
}
