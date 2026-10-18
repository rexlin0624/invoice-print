/**
 * 页面坐标里的一个矩形（pt，**左上原点，y 向下**），与内核 `PageText` / `Slot` 同一套坐标系。
 * 单独放一个文件是为了避免 `raster.ts ↔ thumb.ts ↔ print.ts` 互相 import 成环。
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 区域是否覆盖整页（用来判断「有没有必要裁」） */
export function isFullBox(box: Box, width: number, height: number): boolean {
  return box.x <= 0.5 && box.y <= 0.5 && box.w >= width - 1 && box.h >= height - 1;
}
