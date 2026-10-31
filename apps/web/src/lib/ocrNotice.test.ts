import type { Issue } from '@invoice-tool/core';
import { describe, expect, it } from 'vitest';

import { ocrAssetResponseIsUsable, ocrMissingCount } from './ocrNotice';

function item(codes: string[]): { invoice: { issues: Issue[] } } {
  return {
    invoice: {
      issues: codes.map((code) => ({
        code: code as Issue['code'],
        level: 'warn',
        message: '',
      })),
    },
  };
}

describe('OCR 缺模型提示', () => {
  it('没有票据时不提示', () => {
    expect(ocrMissingCount([], true)).toBe(0);
  });

  it('关掉 OCR 开关时不提示', () => {
    expect(ocrMissingCount([item(['ocr-unavailable'])], false)).toBe(0);
  });

  it('有 ocr-unavailable 的票各计一次', () => {
    const items = [item(['ocr-unavailable']), item([]), item(['ocr-unavailable'])];
    expect(ocrMissingCount(items, true)).toBe(2);
  });

  it('其他问题不算', () => {
    expect(ocrMissingCount([item(['missing-field'])], true)).toBe(0);
  });

  it('同一张票有多条 ocr-unavailable 时只计一次', () => {
    const items = [item(['ocr-unavailable', 'ocr-unavailable', 'ocr-unavailable'])];
    expect(ocrMissingCount(items, true)).toBe(1);
  });

  it('接受 readonly 数组（调用方多为冻结状态）', () => {
    const items = [item(['ocr-unavailable'])] as const;
    expect(ocrMissingCount(items, true)).toBe(1);
  });
});

describe('OCR 模型探测（防 SPA 兜底误判）', () => {
  it('404 → 不可用', () => {
    expect(ocrAssetResponseIsUsable(false, '')).toBe(false);
  });

  it('200 但回的是 HTML（SPA 兜底把缺失路径回成 index.html）→ 不可用', () => {
    expect(ocrAssetResponseIsUsable(true, 'text/html; charset=utf-8')).toBe(false);
  });

  it('200 且是模型文件 → 可用', () => {
    expect(ocrAssetResponseIsUsable(true, 'application/gzip')).toBe(true);
  });

  it('200 且无 Content-Type（Vite 对二进制有时不给类型）→ 可用', () => {
    expect(ocrAssetResponseIsUsable(true, null)).toBe(true);
  });

  it('Content-Type 前有空格（不规范服务器）→ 仍判不可用', () => {
    expect(ocrAssetResponseIsUsable(true, ' text/html')).toBe(false);
  });

  it('text/html5 这类以 text/html 开头的类型 → 不可用', () => {
    expect(ocrAssetResponseIsUsable(true, 'text/html5')).toBe(false);
  });

  // MIME type 按 RFC 2045 §5.1 大小写不敏感，真实服务器可能回 `Text/HTML; charset=UTF-8`。
  // 漏判的后果与「只看 res.ok」相同：模型没装却被当成装了，OCR 静默失败。
  it('大写的 TEXT/HTML → 不可用（MIME 类型大小写不敏感）', () => {
    expect(ocrAssetResponseIsUsable(true, 'TEXT/HTML')).toBe(false);
    expect(ocrAssetResponseIsUsable(true, 'Text/HTML; charset=UTF-8')).toBe(false);
  });
});
