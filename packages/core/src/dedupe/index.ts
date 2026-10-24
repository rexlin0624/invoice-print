/**
 * 去重：三层判定（技术方案 §四.2）。
 *
 *   1. 文件级  —— sha256 相同 → 静默跳过
 *   2. 业务级  —— 发票代码 + 号码相同 → 确定重复（同一张票的 PDF 和 OFD 合并为一张）
 *                  数电票没有代码，只按 20 位号码；老票优先按「代码 + 号码」。
 *                  号码或代码来自 OCR 时，撞号只标记、不自动删（OCR 可能认错数字）。
 *   3. 疑似级  —— 销售方 + 金额 + 开票日期相同 → **只标记，不自动删**，由用户确认
 *
 * 内核不做哈希：sha256 由外壳算好传进来（Web Crypto / Rust 各有一份实现）。
 */

import type { Invoice } from '../model/invoice';

export type DuplicateLevel = 'file' | 'invoice-no' | 'ocr-invoice-no' | 'suspected';

/**
 * 哪一层可以自动跳过。
 *
 * OCR 撞号与疑似层都只是「建议」：前者可能把号码认错，后者可能真是两笔同额消费。
 * 外壳必须用这个函数判断，不要自己写 `level !== 'suspected'` —— 新增层级时那条
 * 判断会把本该人工确认的组也一起跳过。
 */
export function isAutoDropLevel(level: DuplicateLevel): boolean {
  return level === 'file' || level === 'invoice-no';
}

export interface DuplicateGroup {
  level: DuplicateLevel;
  /** 保留哪一张（发票 id） */
  keep: string;
  /** 被判定为重复的（发票 id）；对只标记的层级来说是「建议跳过」 */
  drop: string[];
  /** 给人看的理由 */
  reason: string;
}

export interface DedupeResult {
  groups: DuplicateGroup[];
  /** 去掉重复后应该打印的发票 id */
  kept: string[];
  /** 只标记、不自动删的 id（OCR 撞号、疑似重复） */
  flagged: string[];
}

export interface DedupeOptions {
  /** 是否启用疑似级判定，默认 true（只标记） */
  includeSuspected?: boolean;
}

/** 字段完整度：同号票里挑信息最全的那张留下 */
function completeness(inv: Invoice): number {
  const keys: Array<keyof Invoice> = [
    'invoiceNo', 'invoiceCode', 'issueDate', 'sellerName', 'sellerTaxId',
    'buyerName', 'buyerTaxId', 'amount', 'tax', 'total', 'totalInWords',
  ];
  let n = 0;
  for (const k of keys) if (inv[k] !== undefined) n++;
  // 结构化来源优先（xml/ofd 比 pdf-text 可信）
  const srcBonus = inv.provenance.invoiceNo?.source;
  if (srcBonus === 'xml' || srcBonus === 'ofd') n += 2;
  return n;
}

function pickKeeper(members: readonly Invoice[]): Invoice {
  let best = members[0]!;
  let bestScore = completeness(best);
  for (const inv of members.slice(1)) {
    const score = completeness(inv);
    if (score > bestScore) {
      best = inv;
      bestScore = score;
    }
  }
  return best;
}

/** 发票号码 / 代码里的空白一律去掉再比较（OCR 偶尔会插空格） */
function normalizeId(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, '');
  return normalized ? normalized : undefined;
}

/** 号码或代码来自 OCR：这个撞号不能直接当成同一张票 */
function isOcrIdentity(inv: Invoice): boolean {
  return inv.provenance.invoiceNo?.source === 'ocr' || inv.provenance.invoiceCode?.source === 'ocr';
}

interface BusinessBucket {
  no: string;
  /** 老票的代码；数电票或没取到代码时为空 */
  code?: string;
  members: Invoice[];
}

/**
 * 业务级分组。
 *
 * 老票的唯一标识是「代码 + 号码」，不能只看 8 位号码 —— 不同地区/年份的号码会重复。
 * 但同一张票的不同来源可能一侧有代码、一侧没有，所以分三步：
 *
 *   - 有代码的票先按「代码 + 号码」分组；
 *   - 同号码只对应**一个**代码时，把没代码的票并进去（PDF 与 OFD 各缺一半也能合并）；
 *   - 同号码对应**多个**代码时，不猜缺代码的票属于谁，保持独立（宁可不删，不可错删）。
 */
function collectBusinessBuckets(invoices: readonly Invoice[]): BusinessBucket[] {
  const byNo = new Map<string, { coded: Map<string, Invoice[]>; uncoded: Invoice[] }>();

  for (const inv of invoices) {
    const no = normalizeId(inv.invoiceNo);
    if (no === undefined) continue;
    const code = normalizeId(inv.invoiceCode);

    let entry = byNo.get(no);
    if (entry === undefined) {
      entry = { coded: new Map(), uncoded: [] };
      byNo.set(no, entry);
    }
    if (code === undefined) {
      entry.uncoded.push(inv);
    } else {
      const list = entry.coded.get(code);
      if (list) list.push(inv);
      else entry.coded.set(code, [inv]);
    }
  }

  const buckets: BusinessBucket[] = [];
  for (const [no, entry] of byNo) {
    if (entry.coded.size === 1) {
      const [code, members] = [...entry.coded.entries()][0]!;
      members.push(...entry.uncoded);
      buckets.push({ no, code, members });
      continue;
    }

    for (const [code, members] of entry.coded) {
      buckets.push({ no, code, members });
    }

    // 一个代码都没有：退回到「只按号码」——这是数电票的正常路径，也是老票缺代码时的兜底。
    // 有多个代码时不并入任何一组：缺代码的那张无法确定归属，自动删会误伤真票。
    if (entry.coded.size === 0 && entry.uncoded.length > 1) {
      buckets.push({ no, members: entry.uncoded });
    }
  }

  return buckets;
}

export function findDuplicates(invoices: readonly Invoice[], options: DedupeOptions = {}): DedupeResult {
  const { includeSuspected = true } = options;
  const groups: DuplicateGroup[] = [];
  const flagged: string[] = [];
  const dropped = new Set<string>();

  // ---- 1) 文件级 ----
  const byHash = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    if (inv.sha256 === '') continue;
    const list = byHash.get(inv.sha256);
    if (list) list.push(inv);
    else byHash.set(inv.sha256, [inv]);
  }
  for (const members of byHash.values()) {
    if (members.length < 2) continue;
    const keep = pickKeeper(members);
    const drop = members.filter((m) => m.id !== keep.id).map((m) => m.id);
    drop.forEach((id) => dropped.add(id));
    groups.push({
      level: 'file',
      keep: keep.id,
      drop,
      reason: `文件内容完全相同（sha256 ${keep.sha256.slice(0, 8)}…）`,
    });
  }

  // ---- 2) 业务级：代码 + 号码（没有代码时退回号码）----
  const alive = invoices.filter((i) => !dropped.has(i.id));
  for (const bucket of collectBusinessBuckets(alive)) {
    if (bucket.members.length < 2) continue;
    const ocrSourced = bucket.members.some(isOcrIdentity);
    // 留哪张的建议优先给可信来源：OCR 那张可能连号码都是错的
    const trusted = ocrSourced ? bucket.members.filter((m) => !isOcrIdentity(m)) : bucket.members;
    const keep = pickKeeper(trusted.length > 0 ? trusted : bucket.members);
    const drop = bucket.members.filter((m) => m.id !== keep.id).map((m) => m.id);
    const label =
      bucket.code === undefined
        ? `发票号码相同（${bucket.no}）`
        : `发票代码 + 号码相同（${bucket.code} / ${bucket.no}）`;

    if (ocrSourced) {
      // OCR 认出来的号码/代码不能当铁证：只提示，让人对着票面确认
      drop.forEach((id) => flagged.push(id));
      groups.push({
        level: 'ocr-invoice-no',
        keep: keep.id,
        drop,
        reason: `${label}，但号码或代码来自 OCR，识别可能出错，请核对票面。`,
      });
      continue;
    }

    drop.forEach((id) => dropped.add(id));
    groups.push({
      level: 'invoice-no',
      keep: keep.id,
      drop,
      reason: label,
    });
  }

  // ---- 3) 疑似级：销售方 + 金额 + 日期 ----
  if (includeSuspected) {
    const aliveNo = invoices.filter((i) => !dropped.has(i.id));
    const byKey = new Map<string, Invoice[]>();
    for (const inv of aliveNo) {
      if (inv.sellerName === undefined || inv.total === undefined || inv.issueDate === undefined) continue;
      const key = JSON.stringify([inv.sellerName, inv.total, inv.issueDate]);
      const list = byKey.get(key);
      if (list) list.push(inv);
      else byKey.set(key, [inv]);
    }
    for (const members of byKey.values()) {
      if (members.length < 2) continue;
      // 同号已经被业务级处理掉了（OCR 组则是保留但已标记）。这里再说「号码不同」
      // 会自相矛盾，所以含同号成员的三要素组直接跳过。
      const knownNos = members
        .map((m) => normalizeId(m.invoiceNo))
        .filter((no): no is string => no !== undefined);
      if (new Set(knownNos).size !== knownNos.length) continue;

      const keep = members[0]!;
      const others = members.slice(1);
      others.forEach((m) => flagged.push(m.id));
      groups.push({
        level: 'suspected',
        keep: keep.id,
        drop: others.map((m) => m.id),
        reason: `销售方、金额、日期都相同（${keep.sellerName} · ¥${((keep.total ?? 0) / 100).toFixed(2)} · ${keep.issueDate}），但发票号码不同，请确认。`,
      });
    }
  }

  const kept = invoices.filter((i) => !dropped.has(i.id)).map((i) => i.id);
  return { groups, kept, flagged };
}
