/**
 * 锚点工具。
 *
 * 核心原则（AGENTS.md 第 3 节）：**不做绝对坐标定位，用锚点文字相对定位**。
 * 厂商改版式时，绝对坐标会全废，但「名称：」「价税合计（大写）」这类锚点文字
 * 通常不变，值就在锚点右边/同一行。
 */

import type { PageText, TextLine, TextToken } from './lines';
import { locate } from './lines';

/** 归一化用于比较的标签文本：去空白、统一冒号。 */
export function normalizeLabel(s: string): string {
  return s.replace(/[\s\u00a0]/g, '').replace(/[:：]/g, ':');
}

/** 归一化整段文本（去空白），用于正则跨 token 匹配。 */
export function squash(s: string): string {
  return s.replace(/[\s\u00a0]/g, '');
}

/** 命中的标签原文 */
export interface LabelHit {
  /**
   * 标签所在的 token。单 token 命中时就是原 token；
   * 标签跨 token（OCR 会把「名称:」切成「名」「称」「:」）时是**合成的区间 token**，
   * 其 text 从标签首字开始 —— 这样 `inlineValue()` 对两种情况都成立。
   */
  token: TextToken;
  label: string;
  line: TextLine | undefined;
  /** 标签**结束**所在的 token 下标（`readRightOf` 从 index+1 继续） */
  index: number;
  /** 命中所在的页（少数「按位置推断」的规则需要页宽） */
  page?: PageText;
}

/** 行内归一化文本索引：用来把「标签在行里的字符位置」映射回 token 下标 */
interface LineIndex {
  text: string;
  /** token 下标 → 在 text 里的字符区间（空白 token 不占区间） */
  ranges: { index: number; start: number; end: number }[];
}

function indexLine(line: TextLine): LineIndex {
  const ranges: { index: number; start: number; end: number }[] = [];
  let text = '';
  line.tokens.forEach((token, index) => {
    const norm = normalizeLabel(token.text);
    if (norm === '') return;
    ranges.push({ index, start: text.length, end: text.length + norm.length });
    text += norm;
  });
  return { text, ranges };
}

/** 字符位置 → token 下标（取包含该位置的区间） */
function tokenAt(index: LineIndex, pos: number): number | undefined {
  for (const r of index.ranges) {
    if (pos >= r.start && pos < r.end) return r.index;
  }
  return undefined;
}

/** 把「归一化后的第 offset 个字符」映射回原文的下标（归一化会去空白、统一冒号） */
function offsetInText(text: string, offset: number): number {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/[\s\u00a0]/.test(ch)) continue;
    if (seen >= offset) return i;
    seen += 1;
  }
  return text.length;
}

/**
 * 找出页内所有标签命中，**按阅读顺序**（先行序、再字符序）。
 *
 * 两条路径：
 * ① 单个 token 就以标签开头 —— 文字层的常见形态，直接用原 token；
 * ② 标签被切碎在多个 token 里，或前面粘了噪声（OCR 实测拿到「|名」「称」「:」）——
 *    在**整行归一化文本**里找标签，再把字符区间映射回 token。
 *    这是 OCR 能取到购销方名称的关键：不然「名称：」永远匹配不上，
 *    字段全空却看不出哪里错了。
 */
export function findLabelTokens(
  page: PageText,
  labels: readonly string[],
): LabelHit[] {
  const wanted = labels.map(normalizeLabel).filter((w) => w !== '');
  const hits: LabelHit[] = [];

  for (const line of page.lines) {
    if (line.tokens.length === 0) continue;
    const index = indexLine(line);

    for (let i = 0; i < line.tokens.length; i++) {
      const token = line.tokens[i]!;
      const norm = normalizeLabel(token.text);

      // ① 单 token
      const single = wanted.find((w) => norm.startsWith(w));
      if (single !== undefined) {
        hits.push({ token, label: single, line, index: i, page });
        continue;
      }
      if (token.text.trim() === '' || lenOf(index) === 0) continue;

      // ② 跨 token / 带噪声前缀：从「当前 token 在行内的起点」开始找标签
      const from = index.ranges.find((r) => r.index === i)?.start;
      if (from === undefined) continue;
      const found = searchLabel(index.text, from, wanted);
      if (found === undefined) continue;

      const startIndex = tokenAt(index, found.start);
      const endIndex = tokenAt(index, found.end - 1);
      if (startIndex === undefined || endIndex === undefined) continue;

      if (startIndex === endIndex) {
        // 标签在同一 token 内但不在开头：从标签首字切一段当 token，`inlineValue` 才能取到内联值
        const original = line.tokens[startIndex]!;
        const offset = found.start - (index.ranges.find((r) => r.index === startIndex)?.start ?? 0);
        hits.push({
          token: { ...original, text: original.text.slice(offsetInText(original.text, offset)) },
          label: found.label,
          line,
          index: startIndex,
          page,
        });
      } else {
        const first = line.tokens[startIndex]!;
        const last = line.tokens[endIndex]!;
        hits.push({
          token: {
            text: index.text.slice(found.start, found.end),
            x: first.x,
            y: Math.min(first.y, last.y),
            width: Math.max(0, last.x + last.width - first.x),
            height: Math.max(first.height, last.height),
          },
          label: found.label,
          line,
          index: endIndex,
          page,
        });
      }
      // 跳过已经用掉的 token，避免同一处重复命中
      i = endIndex;
    }
  }
  return hits;
}

function lenOf(index: LineIndex): number {
  return index.text.length;
}

function searchLabel(
  text: string,
  from: number,
  wanted: readonly string[],
): { label: string; start: number; end: number } | undefined {
  for (let s = from; s < text.length; s++) {
    for (const w of wanted) {
      if (text.startsWith(w, s)) return { label: w, start: s, end: s + w.length };
    }
  }
  return undefined;
}

/** 标签 token 内联的剩余部分，如 token="发票号码：" 则返回 ""；token="发票号码：2531" 返回 "2531"。 */
export function inlineValue(token: TextToken, label: string): string {
  const norm = normalizeLabel(token.text);
  const wanted = normalizeLabel(label);
  if (!norm.startsWith(wanted)) return '';
  // 按归一化长度切原文会错位（冒号/空白），所以按「去掉前 wanted 个非空白字符」切
  let seen = 0;
  let cut = token.text.length;
  for (let i = 0; i < token.text.length; i++) {
    const ch = token.text[i]!;
    if (/[\s\u00a0]/.test(ch)) continue;
    const c = ch === '：' ? ':' : ch;
    seen += c.length;
    if (seen >= wanted.length) {
      cut = i + 1;
      break;
    }
  }
  return token.text.slice(cut).trim();
}

export interface ReadOptions {
  /** 最多向右延伸多少 pt（从锚点右边界算起）。默认不限。 */
  maxGap?: number;
  /** 遇到这些标签就停止拼接 */
  stopLabels?: readonly string[];
  /** 是否把右侧多个 token 拼起来，默认 true */
  join?: boolean;
  /** 在右侧值里最多取多少个 token */
  maxTokens?: number;
}

export interface FieldRead {
  value: string;
  anchor: TextToken;
  consumed: TextToken[];
}

/**
 * 从锚点 token 读取值：先看锚点自身是否带值，再取同一行右侧的 token。
 * 返回 undefined 表示锚点右边什么都没有。
 */
export function readValueAt(
  page: PageText,
  hit: LabelHit,
  options: ReadOptions = {},
): FieldRead | undefined {
  const { maxGap = Number.POSITIVE_INFINITY, stopLabels = [], join = true, maxTokens = 8 } = options;

  const inline = inlineValue(hit.token, hit.label);
  if (inline !== '') {
    return { value: inline, anchor: hit.token, consumed: [hit.token] };
  }

  const located = hit.line ? { line: hit.line, index: hit.index } : locate(page.lines, hit.token);
  if (!located) return undefined;

  const anchorRight = hit.token.x + hit.token.width;
  const stop = stopLabels.map(normalizeLabel);
  const wanted: TextToken[] = [];

  for (let i = located.index + 1; i < located.line.tokens.length; i++) {
    const t = located.line.tokens[i]!;
    const gap = t.x - anchorRight;
    if (gap > maxGap) break;
    if (stop.some((s) => normalizeLabel(t.text).startsWith(s))) break;
    wanted.push(t);
    if (wanted.length >= maxTokens) break;
  }

  if (wanted.length === 0) return undefined;
  const value = join ? wanted.map((t) => t.text).join('') : wanted[0]!.text;
  return { value: value.trim(), anchor: hit.token, consumed: wanted };
}

/** 便捷：找第一个标签并读值。 */
export function readField(
  page: PageText,
  labels: readonly string[],
  options?: ReadOptions,
): FieldRead | undefined {
  const hit = findLabelTokens(page, labels)[0];
  if (!hit) return undefined;
  return readValueAt(page, hit, options);
}

/** 页内所有行里，第一行满足正则的整行文本。 */
export function findLineText(page: PageText, re: RegExp): string | undefined {
  for (const line of page.lines) {
    if (re.test(line.text)) return line.text;
  }
  return undefined;
}

/** 在「压掉空白」的整页文本上跑正则，取第 n 个捕获组。 */
export function matchSquashed(page: PageText, re: RegExp, group = 1): string | undefined {
  const m = re.exec(squash(page.lines.map((l) => l.text).join('\n')));
  return m?.[group];
}

/** 直接给正则，返回所有匹配（在压掉空白的全文上）。 */
export function matchAllSquashed(page: PageText, re: RegExp): RegExpExecArray[] {
  const s = squash(page.lines.map((l) => l.text).join('\n'));
  const out: RegExpExecArray[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(s)) !== null) {
    out.push(m);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}
