import { useCallback, useRef, useState } from 'react';

import type { IntakeItem } from '../lib/intake';
import { intakeBytes, intakeFiles } from '../lib/intake';
import { logLine } from '../lib/shell';
import { useStore } from './store';

const ACCEPT = '.pdf,.ofd,.xml,.zip';

/** 收票钩子：拖放 / 选择 / 粘贴都走这里 */
export function useIntake() {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState(false);

  /**
   * 用 ref 读偏好，而不是把 `prefs.ocr` 放进依赖。
   * 否则每次改任意设置都会换掉 `intake` 的引用，
   * 而 `App` 里拖放监听器依赖它 —— 等于每次设置变化都重装一遍全局监听。
   */
  const ocrRef = useRef(state.prefs.ocr);
  ocrRef.current = state.prefs.ocr;

  const run = useCallback(
    async (task: () => Promise<IntakeItem[]>): Promise<IntakeItem[]> => {
      setBusy(true);
      dispatch({ type: 'intake/start' });
      try {
        const items = await task();
        dispatch({ type: 'intake/done', items });
        if (items.length > 0) logLine(`intake ok: ${items.length} 张`);
        return items;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logLine(`intake failed: ${message}`);
        dispatch({
          type: 'intake/fatal',
          message,
        });
        return [];
      } finally {
        setBusy(false);
      }
    },
    [dispatch],
  );

  const intake = useCallback(
    async (input: FileList | File[] | null | undefined): Promise<void> => {
      const files = input ? Array.from(input) : [];
      if (files.length === 0) return;
      await run(() =>
        intakeFiles(files, {
          ocr: ocrRef.current,
          onProgress: (progress) => dispatch({ type: 'intake/progress', progress }),
        }),
      );
    },
    [dispatch, run],
  );

  /** 从字节收票（已报销库「加入本次导入」） */
  const intakeFromBytes = useCallback(
    async (entries: readonly { name: string; data: Uint8Array }[]): Promise<IntakeItem[]> =>
      run(() =>
        intakeBytes(entries, {
          ocr: ocrRef.current,
          onProgress: (progress) => dispatch({ type: 'intake/progress', progress }),
        }),
      ),
    [dispatch, run],
  );

  return { intake, intakeFromBytes, busy, accept: ACCEPT };
}

