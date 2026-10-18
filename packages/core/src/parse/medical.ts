/**
 * 医疗票据的**明细页**识别。
 *
 * 一张医疗收费票据常常是两页：首页有金额与票据号码，后面跟着「医疗收费明细」。
 * 明细页在报销时不需要提交（而且它尺寸不同，混排会把版面搞乱），
 * 参考实现的做法是整页剔除。
 *
 * 判据是**双确认**（两个特征都命中才算），带**安全边界**：
 * 只有当「整份文件不止一页」+「该页同时出现两个明细页独有特征」时才剔除，
 * 且绝不把最后一页也剔掉 —— 宁可多打一页，也不要打出一张空票。
 *
 * ⚠️ **锚点已校正，但仍没有本地真票可以端到端回归**。
 * 2026-10 按三份独立材料复核过锚点写法（见 `docs/解析规则参考.md` §8）：
 * 财政部《关于全面推行医疗收费电子票据管理改革的通知》附件 3 的式样、
 * 参考实现 `fapiao-print/src/ocr.js:183`、以及财政电子票据查验平台的公开样本。
 * 早先本文件把第二个特征写成「所属电子票据**编号**」，真票上印的是「**号码**」，
 * 于是两个特征永远凑不齐 —— 规则在真票上从不触发。这次一并修正。
 * 拿到真票后请照 `docs/解析规则参考.md` §9 复核。
 */

import type { PageText } from '../text/lines';
import { squash } from '../text/anchors';

/**
 * 明细页标题。
 *
 * 全国统一式样里，明细页标题是「医疗收费明细」；
 * 参考实现还接受「医疗门诊 / 医疗住院 / 医疗急诊收费明细」三种带前缀的写法，
 * 这里照抄它的宽松度（前缀可省，三种至多一个）。
 */
const DETAIL_TITLE = /医疗(?:门诊|住院|急诊)?收费明细/;

/**
 * 回指字段：明细页独有的「所属…」前缀。
 *
 * 首页只有「票据号码」，明细页才有「所属电子票据号码」这个指回首页的编号，
 * 所以「所属」前缀本身就是明细页的特征，能挡住普通发票里的商品名误撞。
 *
 * 真票（财政部式样与公开样本）印的是「所属电子票据**号码**」；
 * 「编号」是同一字段的历史写法，一并接受 —— 它必须与标题同时出现才生效。
 */
const DETAIL_BACKREF = /所属电子票据(?:号码|编号)/;

/** 一页的文字是否长得像医疗票据明细页 */
export function isMedicalDetailPage(text: string): boolean {
  const squashed = squash(text);
  return DETAIL_TITLE.test(squashed) && DETAIL_BACKREF.test(squashed);
}

/**
 * 找出该剔除的明细页下标（0 基）。
 *
 * 安全边界：
 * - 只有一页 → 永不剔除（那多半是把特征词印在首页上的版式）
 * - 剔除后会一页不剩 → 永不剔除
 */
export function detectMedicalDetailPages(pages: readonly PageText[]): number[] {
  if (pages.length < 2) return [];

  const hits: number[] = [];
  pages.forEach((page, i) => {
    if (isMedicalDetailPage(page.text)) hits.push(i);
  });

  if (hits.length === 0) return [];
  if (hits.length >= pages.length) return []; // 全中 → 判据失效，宁可不剔
  return hits;
}
