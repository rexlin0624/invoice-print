/**
 * 校验规则。
 *
 * 原则：**只标问题，不擅自改数据**。每个问题都带 field，UI 可以直接定位到那一格让用户改。
 * 规则来自技术方案第四节「校验规则」与实务口径。
 */

import type { Invoice, Issue } from '../model/invoice';
import { makeIssue } from '../model/invoice';
import { capitalToCents } from '../model/money';
import { checkTaxId } from './uscc';

export interface ValidateOptions {
  /** 公司抬头，用于「抬头与设置不一致」提示 */
  companyName?: string;
  /** 公司税号 */
  companyTaxId?: string;
  /** 报销期限（天），超过就提示 */
  reimburseWindowDays?: number;
  /** 今天的日期（ISO）。内核不读时钟，由外壳注入。 */
  today?: string;
}

/** 空串 / 只有空格 = 没设置。避免「与设置的『』不一致」这种噪音提示。 */
function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 20 位数电票号码；8 位老票号码 */
function checkInvoiceNoShape(no: string): Issue | undefined {
  if (/^\d{20}$/.test(no)) return undefined;
  if (/^\d{8}$/.test(no)) return undefined;
  return makeIssue('invoice-no-shape', 'warn', `发票号码形态异常（${no.length} 位）：${no}`, 'invoiceNo');
}

export function validateInvoice(inv: Invoice, options: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];

  // ---- 必填字段 ----
  const required: Array<[keyof Invoice, string]> = [
    ['invoiceNo', '发票号码'],
    ['issueDate', '开票日期'],
    ['sellerName', '销售方名称'],
    ['total', '价税合计'],
  ];
  for (const [field, label] of required) {
    if (inv[field] === undefined) {
      issues.push(makeIssue('missing-field', 'warn', `缺少${label}，请人工确认或手动填写。`, field));
    }
  }

  // ---- 金额平衡：不含税 + 税额 = 价税合计 ----
  if (inv.amount !== undefined && inv.tax !== undefined && inv.total !== undefined) {
    const sum = inv.amount + inv.tax;
    if (sum !== inv.total) {
      issues.push(
        makeIssue(
          'amount-mismatch',
          'error',
          `金额不平：不含税 ${fmt(inv.amount)} + 税额 ${fmt(inv.tax)} = ${fmt(sum)}，但价税合计是 ${fmt(inv.total)}。`,
          'total',
        ),
      );
    }
  }

  // ---- 大写与小写一致 ----
  if (inv.totalInWords !== undefined && inv.total !== undefined) {
    const fromWords = capitalToCents(inv.totalInWords);
    if (fromWords !== undefined && fromWords !== inv.total) {
      issues.push(
        makeIssue(
          'capital-mismatch',
          'error',
          `大写金额「${inv.totalInWords}」= ${fmt(fromWords)}，与小写 ${fmt(inv.total)} 不一致。`,
          'totalInWords',
        ),
      );
    }
  }

  // ---- 税号校验位 ----
  for (const field of ['sellerTaxId', 'buyerTaxId'] as const) {
    const v = inv[field];
    if (v === undefined) continue;
    if (checkTaxId(v) === 'invalid') {
      issues.push(
        makeIssue('tax-id-invalid', 'warn', `${field === 'sellerTaxId' ? '销售方' : '购买方'}税号校验位不对：${v}`, field),
      );
    }
  }

  // ---- 发票号码形态 ----
  if (inv.invoiceNo !== undefined) {
    const issue = checkInvoiceNoShape(inv.invoiceNo);
    if (issue) issues.push(issue);
  }

  // ---- 购销方是否弄反了 / 是否同一主体 ----
  issues.push(...crossCheckParties(inv));

  // ---- 抬头 / 税号与设置不一致（报销风险提示）----
  const wantName = configured(options.companyName);
  const wantTaxId = configured(options.companyTaxId);
  if (wantName !== undefined && inv.buyerName !== undefined && inv.buyerName !== wantName) {
    issues.push(
      makeIssue('low-confidence', 'warn', `购买方抬头是「${inv.buyerName}」，与设置的「${wantName}」不一致。`, 'buyerName'),
    );
  }
  if (wantTaxId !== undefined && inv.buyerTaxId !== undefined && inv.buyerTaxId !== wantTaxId) {
    issues.push(
      makeIssue('low-confidence', 'warn', `购买方税号与设置不一致。`, 'buyerTaxId'),
    );
  }

  // ---- 报销期限 ----
  if (inv.issueDate !== undefined && options.today !== undefined && options.reimburseWindowDays !== undefined) {
    const issued = Date.parse(`${inv.issueDate}T00:00:00Z`);
    const today = Date.parse(`${options.today}T00:00:00Z`);
    if (Number.isFinite(issued) && Number.isFinite(today)) {
      const days = Math.floor((today - issued) / 86_400_000);
      if (days > options.reimburseWindowDays) {
        issues.push(
          makeIssue('low-confidence', 'warn', `开票日期距今 ${days} 天，超过报销期限 ${options.reimburseWindowDays} 天。`, 'issueDate'),
        );
      }
    }
  }

  return issues;
}

function fmt(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

/**
 * 购销方交叉校验。
 *
 * 参考实现里这套有「四条」，其中三条要坐标（双表头的 x 位置、边界取中点）；
 * 本仓库只用**不依赖坐标**的那两条 —— 理由是没有竖版/单栏的真样本，
 * 按没验证过的几何规则去交换字段，风险大于收益。
 * 留下这两条已经能挡住最常见的错：保修方空着导致左右两栏取串了。
 */
function crossCheckParties(inv: Invoice): Issue[] {
  const issues: Issue[] = [];

  // ① 两侧名称一模一样：多半是「读右不过界」失效，把同一栏读了两遍
  if (inv.sellerName !== undefined && inv.buyerName !== undefined && inv.sellerName === inv.buyerName) {
    issues.push(
      makeIssue(
        'party-suspect',
        'warn',
        `销售方与购买方都是「${inv.sellerName}」，购销方可能读串了，请核对。`,
        'buyerName',
      ),
    );
  }

  // ② 两侧税号一样：同一主体自开自受，实务上不合法，几乎一定是读错了
  if (inv.sellerTaxId !== undefined && inv.buyerTaxId !== undefined && inv.sellerTaxId === inv.buyerTaxId) {
    issues.push(
      makeIssue(
        'party-suspect',
        'warn',
        `销售方与购买方的税号相同（${inv.sellerTaxId}），购销方可能读串了，请核对。`,
        'buyerTaxId',
      ),
    );
  }

  return issues;
}

/** 问题严重度汇总，便于 UI 决定卡片上显示什么 */
export function worstLevel(issues: readonly Issue[]): 'ok' | 'warn' | 'error' {
  if (issues.some((i) => i.level === 'error')) return 'error';
  if (issues.some((i) => i.level === 'warn')) return 'warn';
  return 'ok';
}
