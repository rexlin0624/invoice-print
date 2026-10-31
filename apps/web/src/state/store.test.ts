import { describe, expect, it } from 'vitest';

import { initialState } from './store';

describe('首次打开', () => {
  it('落在查重页，而不是合并打印', () => {
    expect(initialState().view).toBe('dedupe');
  });

  it('localStorage 里有旧版本/脏数据时，首屏仍落在查重页', () => {
    // view 从不持久化，但 localStorage 是外部输入：旧版本、手改、同机程序都可能写。
    // 首屏视图不能被任何持久化内容顶回 'merge'。
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => JSON.stringify({ view: 'merge', ocr: 'false', companyTaxId: 123 }),
        setItem: () => undefined,
      },
    };
    try {
      const state = initialState();
      expect(state.view).toBe('dedupe');
      // 顺带钉住：字符串 'false' 不能把布尔偏好改成假
      expect(state.prefs.ocr).toBe(true);
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = original;
    }
  });
});
