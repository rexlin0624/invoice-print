/**
 * 凑票：从一堆发票里挑一组，让「价税合计」之和尽量贴近目标金额。
 *
 * 真实场景：报销有额度（比如差旅上限 3000 元），或者要对上一笔付款金额。
 * 用户要的是一个**能手动再调的好建议**，不是数学上的最优证明 ——
 * 所以这里用「贪心起步 + 分支限界」，并且带节点预算，保证任何输入都在毫秒级返回。
 *
 * 金额全程是整数「分」，不碰浮点。
 */

import type { Invoice } from '../model/invoice';
import type { Cents } from '../model/money';

export type CombineMode =
  /** 不超过目标（报销额度场景）：最大化「和 ≤ 目标」 */
  | 'under'
  /** 最接近目标（对账场景）：最小化 |和 − 目标| */
  | 'nearest';

export interface CombineOptions {
  mode?: CombineMode;
  /** 最多挑几张 */
  maxCount?: number;
  /** 容差（分）：差额在容差内就算「对上了」，默认 0 */
  tolerance?: Cents;
  /**
   * 分支限界的节点预算。超过就停，返回当前最好的解。
   * 默认 20 万 —— 实测千级以内发票在几毫秒内跑完。
   */
  nodeBudget?: number;
}

export interface CombineResult {
  /** 挑中的发票（按金额从大到小） */
  picked: Invoice[];
  sum: Cents;
  target: Cents;
  /** sum − target，负数表示差多少 */
  diff: Cents;
  /** 差额在容差内 */
  within: boolean;
  /** 是否恰好等于目标 */
  exact: boolean;
  /** 是否因为节点预算用完而提前收敛（结果可能不是最优，但一定可用） */
  budgetExhausted: boolean;
}

/** 只有拿到价税合计的票才能参与凑数 —— 没有金额就没法凑 */
export function combinable(invoices: readonly Invoice[]): Invoice[] {
  return invoices.filter((inv) => inv.total !== undefined && inv.total > 0);
}

/** 金额降序。同等金额时按开票日期，保证结果稳定可复现。 */
function byAmountDesc(a: Invoice, b: Invoice): number {
  const d = (b.total ?? 0) - (a.total ?? 0);
  if (d !== 0) return d;
  return (a.issueDate ?? '').localeCompare(b.issueDate ?? '');
}

function sumOf(list: readonly Invoice[]): Cents {
  let s = 0;
  for (const inv of list) s += inv.total ?? 0;
  return s;
}

/**
 * 贪心起步：降序能塞就塞。
 * 它同时是分支限界的初始下界 —— 有个还不错的解兜底，剪枝才能剪得狠。
 */
function greedy(pool: readonly Invoice[], target: Cents, maxCount: number): Invoice[] {
  const picked: Invoice[] = [];
  let sum = 0;
  for (const inv of pool) {
    if (picked.length >= maxCount) break;
    const amount = inv.total ?? 0;
    if (sum + amount <= target) {
      picked.push(inv);
      sum += amount;
    }
  }
  return picked;
}

/**
 * 目标函数：分数越小越好。
 *
 * - `under`：超过目标是**不可接受**的（返回 Infinity），否则差额越小越好
 * - `nearest`：绝对差额越小越好
 */
function cost(sum: Cents, target: Cents, mode: CombineMode): number {
  if (mode === 'under') return sum > target ? Number.POSITIVE_INFINITY : target - sum;
  return Math.abs(target - sum);
}

export function chooseInvoices(
  invoices: readonly Invoice[],
  target: Cents,
  options: CombineOptions = {},
): CombineResult {
  const mode = options.mode ?? 'under';
  const maxCount = Math.max(1, options.maxCount ?? 30);
  const tolerance = Math.max(0, options.tolerance ?? 0);
  const nodeBudget = Math.max(1, options.nodeBudget ?? 200_000);

  const pool = combinable(invoices).sort(byAmountDesc);

  if (pool.length === 0 || target <= 0) {
    return {
      picked: [],
      sum: 0,
      target,
      diff: -target,
      within: false,
      exact: false,
      budgetExhausted: false,
    };
  }

  let best = greedy(pool, target, maxCount);
  let bestCost = cost(sumOf(best), target, mode);
  let nodes = 0;

  // 后缀和：用于「剩下的全拿也不够好」的剪枝
  const suffix = new Array<Cents>(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + (pool[i]!.total ?? 0);

  const chosen: Invoice[] = [];

  const walk = (start: number, sum: Cents): void => {
    if (nodes >= nodeBudget) return;
    nodes += 1;

    const current = cost(sum, target, mode);
    if (current < bestCost || (current === bestCost && chosen.length < best.length)) {
      if (current < Number.POSITIVE_INFINITY) {
        best = [...chosen];
        bestCost = current;
      }
    }
    if (bestCost === 0) return; // 到顶了，没法更好
    if (chosen.length >= maxCount) return;

    for (let i = start; i < pool.length; i++) {
      if (nodes >= nodeBudget) return;
      const inv = pool[i]!;
      const amount = inv.total ?? 0;
      const next = sum + amount;

      // 剪枝 1：`under` 模式下已经超了，后面只会更大（已降序）
      if (mode === 'under' && next > target) {
        // 还不能直接 break：后面可能有更小的票能塞。
        // 但可以用「当前剩余全部加起来也不如现有解」再剪一层。
        continue;
      }
      // 剪枝 2：把剩下的全拿上也追不平当前最优 —— 直接结束这个分支
      if (mode === 'nearest') {
        const remaining = suffix[i + 1]!;
        if (Math.abs(target - (next + remaining)) > bestCost && next < target) continue;
      }

      chosen.push(inv);
      walk(i + 1, next);
      chosen.pop();
    }
  };

  walk(0, 0);

  const sum = sumOf(best);
  const diff = sum - target;
  return {
    picked: best,
    sum,
    target,
    diff,
    within: Math.abs(diff) <= tolerance,
    exact: diff === 0,
    budgetExhausted: nodes >= nodeBudget,
  };
}

/** 按销售方 / 月份分组求和，凑票页面右侧的「都买了什么」小计用 */
export function groupTotals(
  invoices: readonly Invoice[],
  by: 'seller' | 'month',
): Array<{ key: string; count: number; total: Cents }> {
  const map = new Map<string, { count: number; total: Cents }>();
  for (const inv of invoices) {
    const key =
      by === 'seller'
        ? (inv.sellerName ?? '（未知销售方）')
        : (inv.issueDate?.slice(0, 7) ?? '（无日期）');
    const row = map.get(key) ?? { count: 0, total: 0 };
    row.count += 1;
    row.total += inv.total ?? 0;
    map.set(key, row);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.total - a.total);
}
