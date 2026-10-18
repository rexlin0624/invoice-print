/**
 * 去重：三层判定（技术方案 §四.2）。
 *
 *   1. 文件级  —— sha256 相同 → 静默跳过
 *   2. 业务级  —— 发票号码相同 → 确定重复（同一张票的 PDF 和 OFD 合并为一张）
 *   3. 疑似级  —— 销售方 + 金额 + 开票日期相同 → **只标记，不自动删**，由用户确认
 *
 * 内核不做哈希：sha256 由外壳算好传进来（Web Crypto / Rust 各有一份实现）。
 */

import type { Invoice } from '../model/invoice';

export type DuplicateLevel = 'file' | 'invoice-no' | 'suspected';

export interface DuplicateGroup {
  level: DuplicateLevel;
  /** 保留哪一张（发票 id） */
  keep: string;
  /** 被判定为重复的（发票 id） */
  drop: string[];
  /** 给人看的理由 */
  reason: string;
}

export interface DedupeResult {
  groups: DuplicateGroup[];
  /** 去掉重复后应该打印的发票 id */
  kept: string[];
  /** 只标记、不自动删的 id（疑似重复） */
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

export function findDuplicates(invoices: readonly Invoice[], options: DedupeOptions = {}): DedupeResult {
  const { includeSuspected = true } = options;
  const groups: DuplicateGroup[] = [];
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

  // ---- 2) 业务级：发票号码 ----
  const alive = invoices.filter((i) => !dropped.has(i.id));
  const byNo = new Map<string, Invoice[]>();
  for (const inv of alive) {
    if (!inv.invoiceNo) continue;
    const list = byNo.get(inv.invoiceNo);
    if (list) list.push(inv);
    else byNo.set(inv.invoiceNo, [inv]);
  }
  for (const [no, members] of byNo) {
    if (members.length < 2) continue;
    const keep = pickKeeper(members);
    const drop = members.filter((m) => m.id !== keep.id).map((m) => m.id);
    drop.forEach((id) => dropped.add(id));
    groups.push({
      level: 'invoice-no',
      keep: keep.id,
      drop,
      reason: `发票号码相同（${no}）`,
    });
  }

  // ---- 3) 疑似级：销售方 + 金额 + 日期 ----
  const flagged: string[] = [];
  if (includeSuspected) {
    const aliveNo = invoices.filter((i) => !dropped.has(i.id));
    const byKey = new Map<string, Invoice[]>();
    for (const inv of aliveNo) {
      if (inv.sellerName === undefined || inv.total === undefined || inv.issueDate === undefined) continue;
      const key = `${inv.sellerName}__${inv.total}__${inv.issueDate}`;
      const list = byKey.get(key);
      if (list) list.push(inv);
      else byKey.set(key, [inv]);
    }
    for (const members of byKey.values()) {
      if (members.length < 2) continue;
      // 同号已经被业务级处理掉了，这里只可能是不同号但同样三要素 —— 真·疑似
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
