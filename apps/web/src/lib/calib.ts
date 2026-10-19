/**
 * 打印校准测试页。
 *
 * 解决的是这样一个问题：版面算得没错，打出来却整体偏移几毫米 —— 纸的走位、打印机的
 * 成像区、装订边，都会让票出格。用户能做的只有两件事：量出来差多少，把这个差值填回去。
 *
 * 所以这一页不是「发票」，而是一把**尺子**：
 * - 10 mm 方格 + 100 mm 直尺 → 量出打印缩放对不对；
 * - 四角的定位框 + 页边距框 + 中心十字 → 一眼看出往哪个方向偏了多少；
 * - 当前设置（偏移 / 页边距 / 每页张数）用数字印在纸上 → 不用回头翻设置。
 *
 * 偏移值**故意不作用在这张测试页上**：测试页要在「未补偿」的坐标系里量偏差，
 * 如果它也带着补偿走，量出来的永远是自己。
 *
 * ⚠️ 文字只能用 **ASCII**。pdf-lib 的 `StandardFonts.Helvetica` 是 WinAnsi 编码，
 * 画一个汉字会直接抛 `WinAnsi cannot encode ...`；内置中文字体要额外字体文件（几 MB，
 * 而且授权各异）。所以纸面只放数字与短标签，**操作说明放在设置面板里**（就在按钮旁边）。
 * 这条与 `print.ts` 的页码同一个规矩。
 */

import { A4, MARGIN_PT, mm } from '@invoice-tool/core';
import type { LayoutSettings } from '@invoice-tool/core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const GRID_MM = 10;
/** 直尺长度（mm），沿顶部与左侧各画一条 */
const RULER_MM = 100;

const INK = rgb(0.1, 0.1, 0.1);
const FAINT = rgb(0.8, 0.8, 0.8);
const ACCENT = rgb(0.05, 0.4, 0.65);

/**
 * 生成一页校准测试页。**纯几何**，不碰 DOM，也不依赖任何发票数据。
 *
 * 注意 pdf-lib 的坐标系：原点在**左下角**、y 轴向上；内核的几何是 y 轴向下。
 * 转换只发生在这里（`flip` 一处），不让它渗出去。
 */
export async function buildCalibrationPdf(settings: LayoutSettings): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('calibration-sheet');
  doc.setCreator('invoice-tool');
  const page = doc.addPage([A4.width, A4.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  /** 内核 y（向下，从纸顶算）→ pdf-lib y（向上，从纸底算） */
  const flip = (y: number): number => A4.height - y;
  const marginPt = MARGIN_PT[settings.margin];

  // 纸的边框（离纸边 5 mm）
  page.drawRectangle({
    x: mm(5),
    y: mm(5),
    width: A4.width - mm(10),
    height: A4.height - mm(10),
    borderColor: FAINT,
    borderWidth: 0.5,
  });

  // 10 mm 方格；每 50 mm 加深
  for (let x = GRID_MM; x < 210; x += GRID_MM) {
    const at = mm(x);
    page.drawLine({
      start: { x: at, y: mm(5) },
      end: { x: at, y: A4.height - mm(5) },
      color: x % 50 === 0 ? FAINT : rgb(0.93, 0.93, 0.93),
      thickness: x % 50 === 0 ? 0.5 : 0.3,
    });
  }
  for (let y = GRID_MM; y < 297; y += GRID_MM) {
    const at = flip(mm(y));
    page.drawLine({
      start: { x: mm(5), y: at },
      end: { x: A4.width - mm(5), y: at },
      color: y % 50 === 0 ? FAINT : rgb(0.93, 0.93, 0.93),
      thickness: y % 50 === 0 ? 0.5 : 0.3,
    });
  }

  // 页边距框：这就是「票能占的最大范围」，出格说明偏移没调对
  page.drawRectangle({
    x: marginPt,
    y: marginPt,
    width: A4.width - marginPt * 2,
    height: A4.height - marginPt * 2,
    borderColor: ACCENT,
    borderWidth: 0.6,
  });

  // 四角定位框：8 mm 见方，贴着页边距的四个角。
  // 这里直接用 **pdf 坐标**（左下原点）写四个组合，避免「内核 y 当 pdf y」这类错位。
  const corner = mm(8);
  for (const x of [marginPt, A4.width - marginPt - corner]) {
    for (const y of [marginPt, A4.height - marginPt - corner]) {
      page.drawRectangle({ x, y, width: corner, height: corner, borderColor: INK, borderWidth: 0.8 });
    }
  }

  // 中心十字
  page.drawLine({
    start: { x: A4.width / 2 - mm(6), y: A4.height / 2 },
    end: { x: A4.width / 2 + mm(6), y: A4.height / 2 },
    color: INK,
    thickness: 0.6,
  });
  page.drawLine({
    start: { x: A4.width / 2, y: A4.height / 2 - mm(6) },
    end: { x: A4.width / 2, y: A4.height / 2 + mm(6) },
    color: INK,
    thickness: 0.6,
  });

  // 顶部直尺（从左边 5 mm 起，向右 100 mm）
  const topY = flip(mm(16));
  page.drawLine({ start: { x: mm(5), y: topY }, end: { x: mm(5 + RULER_MM), y: topY }, color: INK, thickness: 0.7 });
  for (let x = 0; x <= RULER_MM; x += GRID_MM) {
    const at = mm(5 + x);
    const tall = x % 50 === 0;
    page.drawLine({
      start: { x: at, y: topY },
      end: { x: at, y: topY - mm(tall ? 5 : 2.5) },
      color: INK,
      thickness: 0.6,
    });
    if (tall) page.drawText(String(x), { x: at + 1.2, y: topY - mm(5) - 7, size: 6.5, font, color: INK });
  }

  // 左侧直尺
  const leftX = mm(16);
  page.drawLine({ start: { x: leftX, y: mm(5) }, end: { x: leftX, y: mm(5 + RULER_MM) }, color: INK, thickness: 0.7 });
  for (let y = 0; y <= RULER_MM; y += GRID_MM) {
    const at = flip(mm(5 + y));
    const tall = y % 50 === 0;
    page.drawLine({
      start: { x: leftX, y: at },
      end: { x: leftX - mm(tall ? 5 : 2.5), y: at },
      color: INK,
      thickness: 0.6,
    });
    if (tall) page.drawText(String(y), { x: leftX - mm(5) - 9, y: at - 2.2, size: 6.5, font, color: INK });
  }

  /**
   * 纸面上的读数块。**只有 ASCII**：这里是给尺子配的注记，
   * 完整的中文操作说明在「更多设置 → 打印校准」里（就在按钮下面）。
   */
  const lines = [
    'CALIBRATION SHEET',
    'A4 210 x 297 mm   print at 100% (no fit-to-page)',
    '',
    `offset X ${settings.offsetXMm.toFixed(1)} mm   offset Y ${settings.offsetYMm.toFixed(1)} mm`,
    `margin ${(marginPt / mm(1)).toFixed(0)} mm   ${settings.perPage} per page   ${settings.orientation}`,
    `cut lines ${settings.cutLines ? 'on' : 'off'}   b/w ${settings.blackWhite ? 'on' : 'off'}`,
    '',
    'Measure the blue frame to the paper edge.',
    'Unequal? Fill the difference into offset X / Y.',
  ];
  lines.forEach((line, i) => {
    page.drawText(line, {
      x: mm(18),
      y: flip(mm(42 + i * 6)),
      size: i === 0 ? 11 : 8.5,
      font,
      color: i === 0 ? INK : rgb(0.28, 0.28, 0.28),
    });
  });

  return doc.save();
}
