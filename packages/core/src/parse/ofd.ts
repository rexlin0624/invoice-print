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
import { makeIssue } from '../model/invoice';
import type { PageText, TextToken } from '../text/lines';
import { buildPageText } from '../text/lines';
import { extractInvoiceFields } from './fields';
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

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
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

/** 从 Content.xml 里抽出所有 TextCode（正则足够：OFD 的 Content.xml 结构非常规整） */
function extractTextCodes(contentXml: string): RawTextCode[] {
  const out: RawTextCode[] = [];
  const re = /<(?:[\w.-]+:)?TextCode\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?TextCode>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contentXml)) !== null) {
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
  const w = parts[2]!;
  const h = parts[3]!;
  if (w <= 0 || h <= 0) return fallback;
  return { width: w * MM_TO_PT, height: h * MM_TO_PT };
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

  // ---- 1) 先找结构化 XML 附件（最准）----
  const preferred = xmlEntries.filter(
    (f) => !/\/(Content|Document)\.xml$/i.test(f.name) && !/^OFD\.xml$/i.test(f.name),
  );
  const candidates = [...preferred, ...xmlEntries];

  let best: MapExtraction | undefined;
  let bestScore = 0;
  for (const entry of candidates) {
    // Content.xml 是页面内容流（不是数据），交给下面的文字层路径
    if (/\/Content\.xml$/i.test(entry.name)) continue;
    let text: string;
    try {
      text = await entry.async('string');
    } catch {
      continue;
    }
    if (text.length > 2_000_000) continue;
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
    try {
      return await doc.async('string');
    } catch {
      return undefined;
    }
  })();

  const size = pageSizePt(documentXml);
  const pages: PageText[] = [];

  for (let i = 0; i < contentEntries.length; i++) {
    let xml: string;
    try {
      xml = await contentEntries[i]!.async('string');
    } catch {
      continue;
    }
    const codes = extractTextCodes(xml);
    if (codes.length === 0) continue;

    // 两种朝向各试一遍，取自校验得分高的
    const normal = buildPageText(i, size.width, size.height, toTokens(codes, size.height, false));
    const flipped = buildPageText(i, size.width, size.height, toTokens(codes, size.height, true));
    const chosen = scoreExtraction(flipped) > scoreExtraction(normal) ? flipped : normal;
    pages.push(chosen);
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
