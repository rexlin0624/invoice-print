import { describe, expect, it } from 'vitest';

import type { TextToken } from '../src/text/lines';
import { buildPageText } from '../src/text/lines';
import { extractInvoiceFields, normalizeDate } from '../src/parse/fields';

/**
 * 用**实测坐标**构造一张数电票的文字层（数值抄自真实发票，见 docs/解析规则参考.md）。
 * 这样锚点逻辑可以脱离 pdfjs 被确定性测试。
 */
function tok(text: string, x: number, y: number, width: number): TextToken {
  return { text, x, y, width, height: 9 };
}

const PAGE_W = 595.28;
const PAGE_H = 396.85;

const TOKENS: TextToken[] = [
  // 头部：注意真实 PDF 里 token 顺序是内容流顺序，故意打乱以验证「按 y 分 band + 按 x 排序」
  tok('12345678901234567890', 481.88, 39.4, 90),
  tok('发票号码：', 438.02, 39.52, 45.39),
  tok('电子发票（普通发票）', 192.93, 41.4, 200.86),
  tok('成品油', 108.89, 48.63, 27),
  tok('开票日期：', 438.02, 56.74, 45.39),
  tok('2026年06月19日', 481.88, 56.74, 63),
  // 购销方（左右分栏，同一视觉行）
  tok('名称：', 32.67, 103.52, 27),
  tok('名称：', 317.55, 103.52, 27),
  tok('某某测试甲有限公司', 56.69, 103.52, 126),
  tok('某某测试乙有限公司', 340.15, 103.52, 189),
  tok('统一社会信用代码/纳税人识别号：', 32.51, 133.28, 124.19),
  tok('统一社会信用代码/纳税人识别号：', 317.39, 133.28, 124.19),
  tok('9131000000000011MK', 153.07, 133.28, 129.6),
  tok('9144000000000011MN', 437.95, 133.28, 129.6),
  // 合计
  tok('合', 58.18, 268.24, 9),
  tok('计', 103.54, 268.24, 9),
  tok('¥', 401.51, 268.24, 6.6),
  tok('52.58', 408.11, 268.24, 27),
  tok('¥', 553.41, 268.24, 6.6),
  tok('3.00', 560.01, 268.24, 22.5),
  // 价税合计
  tok('价税合计（大写）', 48.0, 285.87, 72),
  tok('伍拾伍圆伍角捌分', 178.43, 285.87, 90),
  tok('（小写）', 406.84, 285.87, 36),
  tok('¥', 440.83, 285.87, 6.6),
  tok('55.58', 447.43, 285.87, 33),
  // 开票人
  tok('开票人：', 55.35, 375.64, 27),
  tok('张三', 82.35, 375.64, 18),
];

const page = buildPageText(0, PAGE_W, PAGE_H, TOKENS);

describe('文字层分band与排序', () => {
  it('行内按 x 排序，得到阅读顺序', () => {
    const header = page.lines.find((l) => l.text.includes('发票号码'));
    expect(header?.text).toBe('电子发票（普通发票）发票号码：12345678901234567890');
  });

  it('合计行拼接正确', () => {
    const line = page.lines.find((l) => l.text.includes('合计') && !l.text.includes('价税合计'));
    expect(line?.text).toBe('合计¥52.58¥3.00');
  });

  it('价税合计行拼接正确', () => {
    const line = page.lines.find((l) => l.text.includes('价税合计'));
    expect(line?.text).toBe('价税合计（大写）伍拾伍圆伍角捌分（小写）¥55.58');
  });
});

describe('normalizeDate', () => {
  it('多种写法', () => {
    expect(normalizeDate('2026年06月19日')).toBe('2026-06-19');
    expect(normalizeDate('2026-6-9')).toBe('2026-06-09');
    expect(normalizeDate('2026/06/19')).toBe('2026-06-19');
    expect(normalizeDate('20260619')).toBe('2026-06-19');
  });

  it('非法值返回 undefined', () => {
    expect(normalizeDate('2026年13月99日')).toBeUndefined();
    expect(normalizeDate('乱七八糟')).toBeUndefined();
  });
});

describe('extractInvoiceFields（数电票版式）', () => {
  const { fields, anchors } = extractInvoiceFields([page]);

  it('票种与特定业务', () => {
    expect(fields.kind).toBe('vat-general');
    expect(fields.businessTag).toBe('成品油');
  });

  it('发票号码与开票日期', () => {
    expect(fields.invoiceNo).toBe('12345678901234567890');
    expect(fields.issueDate).toBe('2026-06-19');
  });

  it('购销方左右分栏不串栏', () => {
    expect(fields.buyerName).toBe('某某测试甲有限公司');
    expect(fields.sellerName).toBe('某某测试乙有限公司');
    expect(fields.buyerTaxId).toBe('9131000000000011MK');
    expect(fields.sellerTaxId).toBe('9144000000000011MN');
  });

  it('金额：不含税 + 税额 = 价税合计', () => {
    expect(fields.amount).toBe(5258);
    expect(fields.tax).toBe(300);
    expect(fields.total).toBe(5558);
    expect(fields.totalInWords).toBe('伍拾伍圆伍角捌分');
    expect(fields.amount! + fields.tax!).toBe(fields.total);
  });

  it('留下锚点，便于 UI 说明取数来源', () => {
    expect(anchors.invoiceNo).toContain('发票号码');
    expect(anchors.total).toContain('价税合计');
    expect(anchors.sellerName).toBe('名称：');
  });
});

describe('无文字层的页', () => {
  it('不抛异常，返回空结果', () => {
    const empty = buildPageText(0, PAGE_W, PAGE_H, []);
    const { fields } = extractInvoiceFields([empty]);
    expect(fields.invoiceNo).toBeUndefined();
    expect(fields.kind).toBe('unknown');
  });
});

/**
 * OCR 形态的文字层：tesseract 给的是**每个词的紧贴框**，
 * 中文会被切成单字，「名称：」经常拆成「名」「称」「:」，
 * 前面还可能粘着表格边框的噪声（实测拿到「|名」「称」「:」）。
 * 这几条是 M3 修的坑：修复前一张真实扫描件拼出 48 行、锚点全部失配、字段全空。
 */
describe('OCR 形态：标签被切碎 / 带噪声前缀', () => {
  it('「名」「称」「:」分成三个 token 也能命中，并按阅读顺序判购销方', () => {
    const tokens = [
      tok('名', 40, 103, 9),
      tok('称', 51, 103, 9),
      tok(':', 62, 103, 5),
      tok('某某测试甲有限公司', 70, 103, 126),
      tok('名', 320, 103, 9),
      tok('称', 331, 103, 9),
      tok(':', 342, 103, 5),
      tok('某某测试乙有限公司', 350, 103, 189),
    ];
    const { fields } = extractInvoiceFields([buildPageText(0, PAGE_W, PAGE_H, tokens)]);
    expect(fields.buyerName).toBe('某某测试甲有限公司');
    expect(fields.sellerName).toBe('某某测试乙有限公司');
  });

  it('标签前粘了边框噪声（「|名称：」）也能命中，并且取到同一 token 里的内联值', () => {
    const tokens = [
      tok('|名称：某某测试甲有限公司', 40, 103, 160),
      tok('名称：某某测试乙有限公司', 320, 103, 216),
    ];
    const { fields } = extractInvoiceFields([buildPageText(0, PAGE_W, PAGE_H, tokens)]);
    expect(fields.buyerName).toBe('某某测试甲有限公司');
    expect(fields.sellerName).toBe('某某测试乙有限公司');
  });

  it('大空档就停：不会把右栏「销售方」栏里的字吃进购买方名称', () => {
    // 实测形态：购买方名字 → 空档 → 右栏的「销」→ 右栏「名称：」
    const tokens = [
      tok('名称：', 32.67, 103.52, 27),
      tok('某某测试甲有限公司', 56.69, 103.52, 126),
      tok('销', 301.8, 103.52, 8),
      tok('名称：', 317.55, 103.52, 27),
      tok('某某测试乙有限公司', 340.15, 103.52, 189),
    ];
    const { fields } = extractInvoiceFields([buildPageText(0, PAGE_W, PAGE_H, tokens)]);
    expect(fields.buyerName).toBe('某某测试甲有限公司');
    expect(fields.sellerName).toBe('某某测试乙有限公司');
  });
});

describe('只剩一个「名称：」时的归属推断', () => {
  it('位于右半栏 → 销售方（OCR 常把「销售方」认丢）', () => {
    const tokens = [
      tok('名称:', 320, 103, 27),
      tok('某某测试乙有限公司', 350, 103, 189),
    ];
    const { fields } = extractInvoiceFields([buildPageText(0, PAGE_W, PAGE_H, tokens)]);
    expect(fields.sellerName).toBe('某某测试乙有限公司');
    expect(fields.buyerName).toBeUndefined();
  });

  it('位于左半栏且没有「销售方」字样 → 购买方（单栏票的老行为）', () => {
    const tokens = [tok('名称：', 32.67, 103.52, 27), tok('某某测试甲有限公司', 56.69, 103.52, 126)];
    const { fields } = extractInvoiceFields([buildPageText(0, PAGE_W, PAGE_H, tokens)]);
    expect(fields.buyerName).toBe('某某测试甲有限公司');
    expect(fields.sellerName).toBeUndefined();
  });
});
