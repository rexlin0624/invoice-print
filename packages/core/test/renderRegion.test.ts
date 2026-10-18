import { describe, expect, it } from 'vitest';

import { regionRenderArgs } from '../src/pdf/renderRegion';

/**
 * 这一组测试锁的是**一个非常难查的不变量**：
 * pdfjs 的 `transform` 是乘在 viewport 之上的（`CanvasGraphics.beginDrawing()`），
 * 所以 viewport 只能是 scale 1。写成 scale 的后果是缩放被平方，
 * 画布里只剩页面左上角一小块（曾被用户报成「发票显示不全」）。
 */
describe('regionRenderArgs', () => {
  const fakePage = () => {
    const asked: number[] = [];
    return {
      asked,
      page: {
        getViewport: ({ scale }: { scale: number }) => {
          asked.push(scale);
          return { scale };
        },
      },
    };
  };

  it('viewport 只问 scale 1，缩放全部写在 transform 里', () => {
    const { asked, page } = fakePage();
    const args = regionRenderArgs(page, 2.5, { x: 0, y: 0 });

    expect(asked).toEqual([1]);
    expect(args.viewport).toEqual({ scale: 1 });
  });

  it('缩放 s 倍、把区域左上角挪到原点', () => {
    const { page } = fakePage();
    const args = regionRenderArgs(page, 2, { x: 10, y: 4 });

    // [a, b, c, d, e, f]；e/f 是「已按 s 缩放后的设备像素」的平移
    expect(args.transform).toEqual([2, 0, 0, 2, -20, -8]);
  });

  it('原点为 0 时退化成「整页缩放」，不平移', () => {
    const { page } = fakePage();
    const args = regionRenderArgs(page, 1, { x: 0, y: 0 });

    expect(args.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
