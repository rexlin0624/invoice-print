/**
 * OFD 解析。
 *
 * 两条路，按可信度取：
 *   1) OFD 包里常常带一份**结构化 XML 附件**（数电票的原始数据）→ 直接走 XML 解析，最准。
 *   2) 没有附件时，从页面 `Content.xml` 的 `<ofd:TextCode>` 还原文字层，
 *      再复用**同一套锚点提取器**。这样 OFD 和 PDF 的字段规则只有一份。
 *
 * 坐标系：OFD 单位是毫米。关于 Y 轴方向，GB/T 33190 的实现在不同生成器上并不一致，
 * 所以这里**同时算两种朝向，用「哪个朝向提取到的字段更多」来选**——自校验，不靠猜。
 * 等样本库里有了真实 OFD 后应当收紧成单一假设。
 */

import JSZip from 'jszip';

import type { Issue } from '../model/invoice';
import { MAX_INVOICE_PAGES, makeIssue } from '../model/invoice';
import type { PageText, TextToken } from '../text/lines';
import { buildPageText } from '../text/lines';
import { extractInvoiceFields } from './fields';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_TOTAL_BYTES,
  MAX_TEXT_CODES,
  MAX_TEXT_XML_CHARS,
  MAX_XML_BYTES,
  readCapped,
} from './limits';
import type { MapExtraction } from './xml';
import { parseInvoiceXml } from './xml';

const MM_TO_PT = 72 / 25.4;

export interface OfdResult {
  pages: PageText[];
  /** 如果从附件 XML 里拿到了结构化数据 */
  xml?: MapExtraction;
  issues: Issue[];
  /** 诊断信息 */
  note?: string;
}

/**
 * 数字实体解码。`String.fromCodePoint` 对越界值与代理区会抛 `RangeError`，
 * 而这段代码跑在**恶意 OFD** 上 —— 一个 `&#999999999;` 就能让整份票解析失败。
 * 越界时保留原文（宁可显示成乱码，也不要整张票作废）。
 */
function codePoint(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return undefined;
  if (n >= 0xd800 && n <= 0xdfff) return undefined;
  return String.fromCodePoint(n);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (whole, d: string) => codePoint(Number(d)) ?? whole)
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, h: string) => codePoint(parseInt(h, 16)) ?? whole)
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m?.[1];
}

function firstNumber(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const m = /-?\d+(?:\.\d+)?/.exec(s.trim());
  return m ? Number(m[0]) : undefined;
}

interface RawTextCode {
  text: string;
  x: number;
  y: number;
  size: number;
  advance: number;
}

/**
 * 标签名的合法结束符（空白、`/`、`>`）。
 */
function isTagNameEnd(ch: string | undefined): boolean {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * **单次线性**扫描：`TextCode` 的开/闭标签数，顺便查「标签没闭合」。
 *
 * 为什么不用 `indexOf('TextCode')` 再配 `lastIndexOf('<')`：那就是回扫。
 * `"TextCode".repeat(25 万)` 这种内容里每个命中都会往回扫到文件头（O(n²)），
 * 2 MB 就够把解析线程卡死。这里从每个 `<` 出发、只往前看固定长度，总代价 O(n)。
 *
 * 返回 `balanced: false` 时整页跳过：畸形包没有抢救价值，比让正则去猜安全。
 */
function scanTextCodeTags(xml: string): { balanced: boolean; opens: number; closes: number } {
  const MAX_TAG_CHARS = 1024;
  let opens = 0;
  let closes = 0;
  let at = xml.indexOf('<');
  while (at !== -1) {
    let i = at + 1;
    const isClose = xml[i] === '/';
    if (isClose) i += 1;
    const start = i;
    const nameLimit = Math.min(xml.length, start + 64);
    while (i < nameLimit && !isTagNameEnd(xml[i])) i += 1;
    const name = xml.slice(start, i);
    if (name === 'TextCode' || name.endsWith(':TextCode')) {
      // 标签必须在有限长度内闭合，否则正则的 `[^>]*?` 会从这里一路扫到文件尾
      const stop = Math.min(xml.length, i + MAX_TAG_CHARS);
      let close = i;
      while (close < stop && xml[close] !== '>') close += 1;
      if (close >= stop) return { balanced: false, opens, closes };
      if (isClose) closes += 1;
      // `/>` 是自闭合：不计开标签（`<TextCode />` 的 `/` 前面可能有空白）
      else if (xml[close - 1] !== '/') opens += 1;
      // 跳过整个标签（含正文），别在正文里的同名文字上再扫一遍
      at = xml.indexOf('<', close + 1);
      continue;
    }
    at = xml.indexOf('<', at + 1);
  }
  return { balanced: opens === closes, opens, closes };
}

/** 从 Content.xml 里抽出所有 TextCode（正则足够：OFD 的 Content.xml 结构非常规整） */
function extractTextCodes(contentXml: string): RawTextCode[] {
  const out: RawTextCode[] = [];
  if (!scanTextCodeTags(contentXml).balanced) return out;
  // 正文长度也限一下：配平检查挡不住的「深嵌套」在这里被压成 O(n × 1024)
  const re =
    /<(?:[\w.-]+:)?TextCode\b([^>]*?)(?:\/>|>([\s\S]{0,1024}?)<\/(?:[\w.-]+:)?TextCode>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contentXml)) !== null) {
    if (out.length >= MAX_TEXT_CODES) break;
    const tag = m[1] ?? '';
    const raw = m[2];
    const text = raw === undefined ? '' : decodeEntities(raw).trim();
    if (text === '') continue;
    const x = firstNumber(attr(tag, 'X')) ?? 0;
    const y = firstNumber(attr(tag, 'Y')) ?? 0;
    const size = firstNumber(attr(tag, 'Size')) ?? 3;
    const advance = firstNumber(attr(tag, 'DeltaX')) ?? size;
    out.push({ text, x, y, size, advance });
  }
  return out;
}

function toTokens(codes: readonly RawTextCode[], pageHeightPt: number, flipY: boolean): TextToken[] {
  return codes.map((c) => {
    const yPt = c.y * MM_TO_PT;
    return {
      text: c.text,
      x: c.x * MM_TO_PT,
      y: flipY ? pageHeightPt - yPt : yPt,
      // DeltaX 是字符步进；近似宽度用于排序与「锚点右侧」判定，够用
      width: Math.max(c.advance * MM_TO_PT * c.text.length, c.text.length * 1),
      height: c.size * MM_TO_PT,
    };
  });
}

function pageSizePt(documentXml: string | undefined): { width: number; height: number } {
  const fallback = { width: 210 * MM_TO_PT, height: 140 * MM_TO_PT };
  if (documentXml === undefined) return fallback;
  // PhysicalBox / Area: "x y w h"（毫米）
  const m = /<(?:[\w.-]+:)?(?:PhysicalBox|Area)\b[^>]*>([^<]+)</.exec(documentXml);
  if (!m) return fallback;
  const parts = (m[1] ?? '').trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return fallback;
  const width = parts[2]! * MM_TO_PT;
  const height = parts[3]! * MM_TO_PT;
  // 不能只判 > 0：1e-300 mm 会让排版里的 scale 变成 Infinity，1e9 mm 则让画布爆掉。
  // 真实票据在 A5–A3 之间，给一个宽松但有限的范围。
  const MIN_PT = 10;
  const MAX_PT = 20_000;
  if (width < MIN_PT || height < MIN_PT || width > MAX_PT || height > MAX_PT) return fallback;
  return { width, height };
}

function scoreExtraction(page: PageText): number {
  const { fields } = extractInvoiceFields([page]);
  return Object.values(fields).filter((v) => v !== undefined).length;
}

/** 解析 OFD 字节流 → 页面文字层 与/或 结构化字段。不抛异常。 */
export async function parseOfd(data: Uint8Array): Promise<OfdResult> {
  const issues: Issue[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    issues.push(makeIssue('parse-failed', 'error', `OFD 解包失败：${message}`));
    return { pages: [], issues };
  }

  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const xmlEntries = entries.filter((f) => /\.xml$/i.test(f.name));

  /**
   * OFD 走的是自己的解包路径（不是 `expandArchive`），所以预算也得自己记。
   * 一个几十 KB 的 OFD 可以塞几十万个 XML 条目：单条 20 MB 的上限挡不住总量，
   * 这里加「条目数 + 解压总量」两道闸，和压缩包那条路对齐。
   */
  let bytesRead = 0;
  /** 总预算把某一条卡掉了 —— 要报给用户，否则「少了几页」会变成无头案 */
  let budgetHit = false;
  const readEntry = async (
    entry: JSZip.JSZipObject,
    want: number,
  ): Promise<Uint8Array | undefined> => {
    const left = MAX_ARCHIVE_TOTAL_BYTES - bytesRead;
    if (left <= 0) {
      budgetHit = true;
      return undefined;
    }
    const bytes = await readCapped(entry, Math.min(want, left)).catch(() => undefined);
    if (bytes === undefined) {
      // `want` 只卡单条；只有「剩余总量」更小时才算总预算用尽
      if (left <= want) budgetHit = true;
      return undefined;
    }
    bytesRead += bytes.byteLength;
    return bytes;
  };

  // ---- 1) 先找结构化 XML 附件（最准）----
  const preferred = xmlEntries.filter(
    (f) => !/\/(Content|Document)\.xml$/i.test(f.name) && !/^OFD\.xml$/i.test(f.name),
  );
  // 去重：`preferred` 是 `xmlEntries` 的子集，直接拼会把同一批 XML 解压两遍。
  const candidates = [...new Set([...preferred, ...xmlEntries])].slice(0, MAX_ARCHIVE_ENTRIES);

  let best: MapExtraction | undefined;
  let bestScore = 0;
  for (const entry of candidates) {
    // Content.xml 是页面内容流（不是数据），交给下面的文字层路径
    if (/\/Content\.xml$/i.test(entry.name)) continue;
    // 附件 XML 也可能很大：先限字节，再限字符，全程流式读
    const bytes = await readEntry(entry, MAX_XML_BYTES);
    if (bytes === undefined) continue;
    const text = new TextDecoder().decode(bytes);
    if (text.length > MAX_TEXT_XML_CHARS) continue;
    const parsed = parseInvoiceXml(text);
    const score = Object.values(parsed.fields).filter((v) => v !== undefined).length;
    if (score > bestScore) {
      bestScore = score;
      best = parsed;
    }
  }

  // ---- 2) 文字层：Content.xml 的 TextCode ----
  const contentEntries = entries.filter((f) => /Pages\/[^/]+\/Content\.xml$/i.test(f.name));
  contentEntries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  const documentXml = await (async (): Promise<string | undefined> => {
    const doc = xmlEntries.find((f) => /Document\.xml$/i.test(f.name));
    if (!doc) return undefined;
    const bytes = await readEntry(doc, MAX_XML_BYTES);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  })();

  const size = pageSizePt(documentXml);
  const pages: PageText[] = [];
  const pageBudget = Math.min(contentEntries.length, MAX_INVOICE_PAGES);
  if (contentEntries.length > MAX_INVOICE_PAGES) {
    issues.push(
      makeIssue(
        'page-count-clamped',
        'warn',
        `OFD 里有 ${contentEntries.length} 页，超过 ${MAX_INVOICE_PAGES} 页的上限，只按前 ${MAX_INVOICE_PAGES} 页处理。`,
      ),
    );
  }

  for (let i = 0; i < pageBudget; i++) {
    // Content.xml 解出来之后才限字符已经晚了：先按「每字符最多 4 字节」限字节。
    const bytes = await readEntry(contentEntries[i]!, MAX_TEXT_XML_CHARS * 4);
    if (bytes === undefined) continue;
    const xml = new TextDecoder().decode(bytes);
    if (xml.length > MAX_TEXT_XML_CHARS) continue;
    const codes = extractTextCodes(xml);
    if (codes.length === 0) continue;

    // 两种朝向各试一遍，取自校验得分高的
    const normal = buildPageText(i, size.width, size.height, toTokens(codes, size.height, false));
    const flipped = buildPageText(i, size.width, size.height, toTokens(codes, size.height, true));
    const chosen = scoreExtraction(flipped) > scoreExtraction(normal) ? flipped : normal;
    pages.push(chosen);
  }

  if (budgetHit || bytesRead >= MAX_ARCHIVE_TOTAL_BYTES) {
    issues.push(
      makeIssue(
        'file-too-large',
        'warn',
        `OFD 解压后超过 ${MAX_ARCHIVE_TOTAL_BYTES / (1024 * 1024)} MB 的预算，后面的内容没有继续读取。`,
      ),
    );
  }

  if (bestScore >= 3 && best) {
    return {
      pages,
      xml: best,
      issues,
      note: `使用 OFD 内嵌结构化 XML（命中 ${bestScore} 个字段）`,
    };
  }

  if (pages.length === 0) {
    issues.push(
      makeIssue('no-text-layer', 'warn', 'OFD 里既没有可用的结构化 XML，也没有解析出页面文字层。'),
    );
  }

  return { pages, issues, note: bestScore > 0 ? `仅从 XML 命中 ${bestScore} 个字段，改用文字层` : undefined };
}
