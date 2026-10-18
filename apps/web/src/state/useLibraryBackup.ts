/**
 * 本机备份的 React 绑定（只有桌面版有备份，网页版永远是空的）。
 *
 * 备份的**写入**是自动的（每次库变动，见 `library.ts` 的调用方与 `useLibrarySync`），
 * 这里只管**读取与恢复**：库页据此显示「备份里有 N 条不在库里」。
 * 这是「有情况才出现」的那类 UI —— 一切正常时它什么都不显示。
 */

import { useCallback, useEffect, useState } from 'react';

import type { Backup, BackupRecord, BackupSummary } from '../lib/libraryBackup';
import { missingFrom, readBackup, restoreFromBackup, summaryOf } from '../lib/libraryBackup';
import { useLibrary } from './useLibrary';

export interface LibraryBackupState {
  /** 备份里有、当前库里没有的记录 */
  missing: BackupRecord[];
  summary?: BackupSummary;
  restoring: boolean;
  /** 恢复并返回恢复了几条 */
  restore: () => Promise<number>;
  /** 重新读一次备份（恢复之后、或外部改过文件之后） */
  reload: () => Promise<void>;
}

export function useLibraryBackup(): LibraryBackupState {
  const records = useLibrary();
  const [backup, setBackup] = useState<Backup | undefined>(undefined);
  const [restoring, setRestoring] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setBackup(await readBackup());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const restore = useCallback(async (): Promise<number> => {
    if (!backup) return 0;
    setRestoring(true);
    try {
      const restored = await restoreFromBackup(backup);
      await reload();
      return restored;
    } finally {
      setRestoring(false);
    }
  }, [backup, reload]);

  const summary = backup ? summaryOf(backup) : undefined;
  return {
    missing: backup ? missingFrom(records, backup) : [],
    ...(summary ? { summary } : {}),
    restoring,
    restore,
    reload,
  };
}
