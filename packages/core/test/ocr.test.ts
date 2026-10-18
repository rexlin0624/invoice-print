/**
 * OCR 路径的回归（M3）。
 *
 * 这里**不测 OCR 本身**（那是外壳的 tesseract，识别率靠实测，不靠单测）。
 * 测的是**契约**：
 *   - 外壳把像素变成与文字层同构的 token 之后，内核那套锚点规则确实能取到字段
 *   - 出处标成 `ocr`，置信度 0.6
 *   - 有文字层时 OCR 结果**不会**被用上（阶梯语义：0.85 压 0.6）
 *
 * 这样即使将来换掉 tesseract，这些用例仍然有效。
 */

import { describe, expect, it } from 'vitest';

import type { OcrPageInput } from '../src/parse/index';
import { parseInvoiceFile } from '../src/parse/index';
import type { TextToken } from '../src/text/lines';

/** 造一个 token（宽度按字数估，够用了） */
function t(text: string, x: number, y: number, width = text.length * 8): TextToken {
  return { text, x, y, width, height: 9 };
}

/** 一张模拟扫描件数电票（词级 token，和 tesseract 给的一样） */
function scannedPage(): OcrPageInput {
  return {
    width: 595,
    height: 397,
    tokens: [
      t('电子发票（普通发票）', 220, 20, 160),
      t('发票号码：', 60, 39),
      t('12345678901234567890', 104, 39, 160),
      t('开票日期：', 60, 57),
      t('2026年06月19日', 104, 57, 112),
      t('名称：', 40, 103),
      t('某某测试甲有限公司', 68, 103, 208),
      t('统一社会信用代码/纳税人识别号：', 40, 119, 240),
      t('9131000000000011MK', 282, 119, 144),
      t('名称：', 320, 103),
      t('某某测试乙有限公司', 348, 103, 300),
      t('统一社会信用代码/纳税人识别号：', 320, 119, 240),
      t('9144000000000011MN', 562, 119, 144),
      t('价税合计（大写）伍拾伍圆伍角捌分（小写）¥55.58', 40, 286, 320),
      t('合计', 40, 250),
      t('¥52.58', 200, 250),
      t('¥3.00', 300, 250),
    ],
  };
}

/** 一张 PNG 的前 8 个魔数字节 + 一点内容（内核只看魔数判格式） */
function fakePng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function parseImage(ocrPages?: OcrPageInput[]) {
  return parseInvoiceFile({
    id: 'img',
    fileName: 'scan.png',
    data: fakePng(),
    sha256: 'x'.repeat(64),
    ...(ocrPages ? { ocrPages } : {}),
  });
}

describe('OCR：图片票能取出字段', () => {
  it('票种、号码、日期、购销方、价税合计都取得到', async () => {
    const { invoice } = await parseImage([scannedPage()]);

    expect(invoice.kind).toBe('vat-general');
    expect(invoice.invoiceNo).toBe('12345678901234567890');
    expect(invoice.issueDate).toBe('2026-06-19');
    expect(invoice.sellerName).toContain('某某测试乙有限公司');
    expect(invoice.buyerName).toContain('某某测试甲有限公司');
    expect(invoice.total).toBe(5558);
  });

  it('每个字段的出处都是 ocr，置信度 0.6', async () => {
    const { invoice } = await parseImage([scannedPage()]);
    for (const field of ['invoiceNo', 'issueDate', 'total'] as const) {
      expect(invoice.provenance[field]).toEqual({ source: 'ocr', confidence: 0.6 });
    }
  });

  it('发一条 ocr-used 提示，提醒复核关键字段', async () => {
    const { invoice } = await parseImage([scannedPage()]);
    const issue = invoice.issues.find((i) => i.code === 'ocr-used');
    expect(issue?.level).toBe('info');
    expect(issue?.message).toContain('复核');
    // 有 OCR 结果时就不该再喊「需要 OCR」
    expect(invoice.issues.map((i) => i.code)).not.toContain('unsupported-format');
  });

  it('内容尺寸来自 OCR 的页面尺寸（图片票排版要用它）', async () => {
    const { contentSize } = await parseImage([scannedPage()]);
    expect(contentSize).toEqual({ width: 595, height: 397 });
  });

  it('没有 OCR 结果时退回原来的行为（不崩、给提示）', async () => {
    const { invoice } = await parseImage();
    expect(invoice.kind).toBe('unknown');
    expect(invoice.issues.map((i) => i.code)).toContain('unsupported-format');
  });

  it('OCR 结果是空页时不当作有效文档', async () => {
    const { invoice } = await parseImage([{ width: 595, height: 397, tokens: [] }]);
    expect(invoice.kind).toBe('unknown');
    expect(invoice.issues.map((i) => i.code)).toContain('unsupported-format');
  });
});

describe('OCR：阶梯语义', () => {
  it('二维码（0.95）盖过 OCR 取到的号码', async () => {
    const page = scannedPage();
    // OCR 把号码认错了一位
    page.tokens = page.tokens.map((token) =>
      token.text === '12345678901234567890' ? { ...token, text: '12345678901234567893' } : token,
    );
    const { invoice } = await parseInvoiceFile({
      id: 'img2',
      fileName: 'scan.png',
      data: fakePng(),
      sha256: 'y'.repeat(64),
      qrPayload: '01,32,,12345678901234567890,55.58,20260619,,300A',
      ocrPages: [page],
    });

    expect(invoice.invoiceNo).toBe('12345678901234567890');
    expect(invoice.provenance.invoiceNo?.source).toBe('qr');
    // 认错这件事必须说出来，不能静默改掉
    expect(invoice.issues.map((i) => i.code)).toContain('qr-mismatch');
  });

  it('OCR 的置信度低于文字层，所以有文字层的 PDF 不受 OCR 影响', async () => {
    // 用一个真的文字层 PDF：内核只会用文字层，ocrPages 里的错值必须被忽略
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), '..', '..', 'samples', 'private');
    const names = await readdir(dir).catch(() => [] as string[]);
    const name = names.find((n) => n.toLowerCase().endsWith('.pdf'));
    if (!name) return; // 没有私有样本时跳过（CI 上就是这样）

    const bytes = new Uint8Array(await readFile(join(dir, name)));
    // OCR 给出一个明显错误的号码：如果它被采纳了，下面两条断言就会挂
    const wrong = scannedPage();
    wrong.tokens = wrong.tokens.map((token) =>
      token.text === '12345678901234567890' ? { ...token, text: '11111111111111111111' } : token,
    );
    const { invoice } = await parseInvoiceFile({
      id: 'pdf',
      fileName: name,
      data: bytes,
      sha256: 'z'.repeat(64),
      ocrPages: [wrong],
    });

    expect(invoice.invoiceNo).not.toBe('11111111111111111111');
    expect(invoice.provenance.invoiceNo?.source).toBe('pdf-text');
    expect(invoice.issues.map((i) => i.code)).not.toContain('ocr-used');
  });
});
