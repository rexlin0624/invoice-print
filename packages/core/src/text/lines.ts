/**
 * 文字层结构：token → 行 → 页 → 文档。
 *
 * 为什么要自己拼行：PDF 文字层的 token 顺序是**内容流顺序**，不是阅读顺序；
 * 而字段提取必须依赖「视觉行」。这里的做法是：
 *   1) 按 y 分 band，容差随**字号**走（见 `adaptiveTolerance`）
 *   2) band 内严格按 x 排序
 * 这样得到的 `text` 才是人眼看到的顺序。
 *
 * 为什么容差不能写死 2pt：文字层同一行的基线几乎一致，2pt 够用；
 * 但 OCR 给的是**每个词的紧贴框**，同一行的 y 会差几个像素。
 * 写死 2pt 会把扫描件的行拆碎、跨行串字，锚点全部失配
 * （实测：一张扫描件被拼成 48 行、每行一两个字）。
 * 按中位字高的 1/4 取容差，两种来源都成立，而且不依赖单位（pt / 像素都行）。
 */

export interface TextToken {
  text: string;
  /**
   * 左边界；原点在左上，y 轴向下。
   * `y` 对文字层是**基线**、对 OCR 是**框顶** —— 分行只比较相对顺序，
   * 所以两者可以共用一套（不要把这里的 y 当成精确的框顶去用）。
   */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLine {
  /** 行基线 y（band 内平均值） */
  y: number;
  x1: number;
  x2: number;
  tokens: TextToken[];
  /** band 内按 x 拼接后的文本 */
  text: string;
}

export interface PageText {
  /** 0 基页号 */
  index: number;
  /** 页面尺寸（pt），已按 /Rotate 归一化 */
  width: number;
  height: number;
  tokens: TextToken[];
  lines: TextLine[];
  /** 按行拼接的全文 */
  text: string;
}

export interface DocumentText {
  pages: PageText[];
  text: string;
  /** 是否从文字层真的拿到了内容 */
  hasText: boolean;
}

/** 同一行的 y 容差下限（pt） */
export const LINE_TOLERANCE = 2;
/** 容差 = 页内中位字高 × 这个比例（下限见上） */
export const LINE_TOLERANCE_RATIO = 0.25;

/** 按中位字高取容差：字号大 → 同一行的抖动绝对值也大 */
export function adaptiveTolerance(tokens: readonly TextToken[]): number {
  const heights = tokens
    .map((t) => t.height)
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return LINE_TOLERANCE;
  const median = heights[Math.floor(heights.length / 2)]!;
  return Math.max(LINE_TOLERANCE, median * LINE_TOLERANCE_RATIO);
}

export function buildLines(tokens: readonly TextToken[], tolerance?: number): TextLine[] {
  const usable = tokens.filter((t) => t.text.trim() !== '');
  if (usable.length === 0) return [];
  const tol = tolerance ?? adaptiveTolerance(usable);

  const byY = [...usable].sort((a, b) => a.y - b.y);
  const bands: TextToken[][] = [];
  const bandY: number[] = [];

  for (const t of byY) {
    const lastIdx = bands.length - 1;
    const lastY = lastIdx >= 0 ? bandY[lastIdx] : undefined;
    if (lastIdx >= 0 && lastY !== undefined && Math.abs(lastY - t.y) <= tol) {
      bands[lastIdx]!.push(t);
      // band 的参考 y 用首个 token 的 y，保持稳定（不随新增 token 漂移）
    } else {
      bands.push([t]);
      bandY.push(t.y);
    }
  }

  return bands.map((band) => {
    const sorted = [...band].sort((a, b) => a.x - b.x);
    const y = sorted.reduce((s, t) => s + t.y, 0) / sorted.length;
    return {
      y,
      x1: Math.min(...sorted.map((t) => t.x)),
      x2: Math.max(...sorted.map((t) => t.x + t.width)),
      tokens: sorted,
      text: sorted.map((t) => t.text).join(''),
    };
  });
}

export function buildPageText(
  index: number,
  width: number,
  height: number,
  tokens: readonly TextToken[],
): PageText {
  const lines = buildLines(tokens);
  return {
    index,
    width,
    height,
    tokens: [...tokens],
    lines,
    text: lines.map((l) => l.text).join('\n'),
  };
}

export function buildDocumentText(pages: readonly PageText[]): DocumentText {
  const text = pages.map((p) => p.text).join('\n');
  return { pages: [...pages], text, hasText: text.replace(/\s/g, '') !== '' };
}

/** 页内所有行的文本 */
export function pageLinesText(page: PageText): string {
  return page.lines.map((l) => l.text).join('\n');
}

/** 找到包含该 token 的行及其下标 */
export function locate(
  lines: readonly TextLine[],
  token: TextToken,
): { line: TextLine; index: number } | undefined {
  for (const line of lines) {
    const index = line.tokens.indexOf(token);
    if (index !== -1) return { line, index };
  }
  return undefined;
}
