import type { Invoice } from '@invoice-tool/core';
import { describe, expect, it } from 'vitest';

import type { IntakeItem } from './intake';
import { fallbackReasonOf, previewFallbacks } from './fallback';

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'id',
    fileName: '票.ofd',
    fileSize: 100,
    sha256: 'hash',
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

function item(over: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id: 'i1',
    invoice: invoice(),
    data: new Uint8Array([1, 2, 3]),
    visual: 'pdf',
    embeddable: true,
    width: 595,
    height: 397,
    ...over,
  };
}

describe('fallbackReasonOf — 印不印得成票面', () => {
  it('OFD / XML 没有票面图像 → no-visual（已知降级，必须提前告知）', () => {
    expect(fallbackReasonOf(item({ visual: 'none', embeddable: false }))).toBe('no-visual');
  });

  it('空字节（解析失败的占位票）→ empty', () => {
    expect(fallbackReasonOf(item({ data: new Uint8Array() }))).toBe('empty');
  });

  it('PDF 与图片都印得成 → 没有降级', () => {
    expect(fallbackReasonOf(item({ visual: 'pdf' }))).toBeNull();
    expect(fallbackReasonOf(item({ visual: 'image', imageMime: 'image/png' }))).toBeNull();
  });

  it('「嵌不进去」只能等合成之后才知道 —— 事前判定不越权', () => {
    // 正常情况下（有字节、有票面）返回 null：embed-failed 由 composePrintPdf 补上
    expect(fallbackReasonOf(item())).toBeNull();
  });
});

describe('previewFallbacks — 打印前就能列出的降级清单', () => {
  it('只收印不成的，带上文件名给 UI 复述', () => {
    const out = previewFallbacks([
      item({ id: 'a', visual: 'pdf' }),
      item({ id: 'b', visual: 'none', invoice: invoice({ fileName: '数电票.ofd' }) }),
      item({ id: 'c', data: new Uint8Array(), invoice: invoice({ fileName: '坏了.pdf' }) }),
    ]);
    expect(out).toEqual([
      { id: 'b', fileName: '数电票.ofd', reason: 'no-visual' },
      { id: 'c', fileName: '坏了.pdf', reason: 'empty' },
    ]);
  });

  it('全是正常票 → 空清单（UI 不该弹任何确认）', () => {
    expect(previewFallbacks([item({ id: 'a' }), item({ id: 'b' })])).toEqual([]);
  });
});
