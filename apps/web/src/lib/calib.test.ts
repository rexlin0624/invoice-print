/**
 * 校准测试页的回归。
 *
 * 这里只测「生成了什么」—— 一页 A4、能重新读回来、页面尺寸正确。真正的几何
 * （方格 / 直尺 / 页边距框）靠肉眼与尺子在纸上验，没法在单测里断言。
 *
 * 但它能挡住一类**真的会翻车**的错：
 * pdf-lib 的 `StandardFonts` 是 WinAnsi 编码，纸面上写一个汉字会直接抛
 * `WinAnsi cannot encode ...`，而按钮在设置抽屉里、不在主流程上 ——
 * 没有这条测试，用户点到才发现「校准页生成失败」。**纸面文字必须只有 ASCII。**
 */

import { describe, expect, it } from 'vitest';

import { A4, DEFAULT_LAYOUT_SETTINGS } from '@invoice-tool/core';
import { PDFDocument } from 'pdf-lib';

import { buildCalibrationPdf } from './calib';

describe('打印校准测试页', () => {
  it('生成一页 A4，能重新读回来', async () => {
    const bytes = await buildCalibrationPdf(DEFAULT_LAYOUT_SETTINGS);
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const [page] = doc.getPages();
    expect(page!.getWidth()).toBeCloseTo(A4.width, 2);
    expect(page!.getHeight()).toBeCloseTo(A4.height, 2);
  });

  it('换设置（宽边距 / 4 张 / 有偏移）也不炸', async () => {
    const bytes = await buildCalibrationPdf({
      ...DEFAULT_LAYOUT_SETTINGS,
      margin: 'wide',
      perPage: 4,
      orientation: 'landscape',
      offsetXMm: 3.5,
      offsetYMm: -2,
      blackWhite: true,
      cutLines: false,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});
