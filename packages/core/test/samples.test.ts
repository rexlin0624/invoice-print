/**
 * 真实样本回归。
 *
 * 样本放在 `samples/`（内容不入库，见 samples/README.md）。没有样本时整组跳过，
 * 这样 CI 上别人 clone 下来也不会红。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import type { Invoice } from '../src/model/invoice';
import type { ParseOutcome } from '../src/parse/index';
import { parseInvoiceFile } from '../src/parse/index';
import { validateInvoice } from '../src/validate/index';
import { loadSamples, resolveSamplesDir, samplesDirWasExplicit } from './helpers/samples';

const SAMPLES_DIR = resolveSamplesDir();
const explicitDir = samplesDirWasExplicit();
const { samples, ignored } = await loadSamples(SAMPLES_DIR);

/**
 * 没有基线的票必须**看得见**。
 *
 * 静默漏掉一张票和「本来就没样本」在输出上一模一样，而前者会让回归少跑一张还没人知道。
 * 显式 `SAMPLES_DIR` 时直接判失败（你指过去的目录，每张票都该有基线）；
 * 默认目录只警告 —— 那里可能有开发时临时扔进去的文件。
 */
if (ignored.length > 0) {
  console.warn(
    `[samples] ${ignored.length} 张票缺同名 .expected.json，未纳入回归：\n  ${ignored.join('\n  ')}`,
  );
}

/**
 * 没有任何样本时整组跳过 —— 但**只在没显式指定目录时**。
 *
 * `SAMPLES_DIR` 指过去却一张都没找到，说明路径错了、或者期望文件没写，
 * 这时跳过等于「静默空跑一轮回归」，比红掉危险得多。
 */
describe.skipIf(samples.length === 0 && !explicitDir)('真实样本回归', () => {
  it('找到了可用的样本', () => {
    const detail =
      ignored.length > 0
        ? `；另有 ${ignored.length} 个票缺同名 .expected.json：${ignored.join(', ')}`
        : '';
    expect(
      samples.length,
      `在 ${SAMPLES_DIR} 下没找到「票 + 同名 .expected.json」${detail}`,
    ).toBeGreaterThan(0);
  });

  // 显式指定目录时，缺基线的票会让这轮回归少跑一张却依然「全绿」，
  // 所以要红。默认目录只警告（见文件顶部）。
  it.skipIf(!explicitDir)('显式目录里的每张票都写了基线', () => {
    expect(ignored, `缺同名 .expected.json：${ignored.join(', ')}`).toEqual([]);
  });

  for (const sample of samples) {
    describe(sample.name, () => {
      let invoice!: Invoice;
      let outcome!: ParseOutcome;
      let data!: Uint8Array;

      it('解析成功且不抛异常', async () => {
        data = new Uint8Array(await readFile(sample.file));
        const sha256 = createHash('sha256').update(data).digest('hex');
        outcome = await parseInvoiceFile({
          id: sample.name,
          fileName: sample.name,
          data,
          sha256,
        });
        invoice = outcome.invoice;
        expect(invoice.sha256).toBe(sha256);
        expect(invoice.issues.filter((i) => i.level === 'error')).toEqual([]);
      });

      /**
       * 回归：pdfjs 在浏览器里会把传入的 ArrayBuffer 转移给 worker，
       * 转移后调用方的 Uint8Array 变成 detached，再读就抛
       * 「Cannot perform Construct on a detached ArrayBuffer」。
       * 这个 bug 在 Node 里不会出现，所以必须在这里钉住「原字节仍可读」。
       */
      it('解析后调用方的字节仍可读（不被 transfer）', () => {
        expect(data.byteLength).toBeGreaterThan(0);
        // 全量读一遍并比对哈希：detached 的 ArrayBuffer 在这里会直接抛，
        // 而不只是「前 5 个字节」那一小段还能读。
        expect(createHash('sha256').update(data).digest('hex')).toBe(invoice.sha256);
        // PDF 的魔数只在 PDF 上检查：OFD 是 zip、XML 是文本，硬套 %PDF- 会误报。
        if (sample.name.toLowerCase().endsWith('.pdf')) {
          expect(data.subarray(0, 5)).toEqual(new TextEncoder().encode('%PDF-'));
        }
      });

      it('字段与基线一致', () => {
        const expected: Record<string, unknown> = { ...sample.expected };
        delete expected.note;
        delete expected.qr;
        for (const [key, want] of Object.entries(expected)) {
          if (key === 'contentSize') {
            const size = want as { width: number; height: number };
            expect(outcome.contentSize?.width, '页面宽').toBeCloseTo(size.width, 2);
            expect(outcome.contentSize?.height, '页面高').toBeCloseTo(size.height, 2);
            continue;
          }
          const got = (invoice as unknown as Record<string, unknown>)[key];
          expect(got, `字段 ${key}`).toBe(want);
        }
      });

      it('通过自洽校验', () => {
        const issues = validateInvoice(invoice);
        // 真实票不应该出现 error 级问题
        expect(issues.filter((i) => i.level === 'error')).toEqual([]);
      });

      /**
       * 二维码交叉校验的**真票回归**。
       *
       * `expected.qr.payload` 是用 zxing-wasm 从票面左上角实解出来的原文
       * （解一次就固化成基线，CI 上不需要 WASM）。
       * 这里注入它重跑一遍，验证三件事：
       *   1. 二维码与票面文字层在号码/价税合计/开票日期上**完全一致**（不一致会出 qr-mismatch）；
       *   2. 一致时二维码仍按阶梯取胜（provenance.source 变 qr）；
       *   3. 字段值与基线一字不差。
       */
      const qr = (sample.expected.qr ?? {}) as { payload?: string };
      it.skipIf(qr.payload === undefined)('二维码与文字层一致，且按阶梯取自二维码', async () => {
        const withQr = await parseInvoiceFile({
          id: sample.name,
          fileName: sample.name,
          data: new Uint8Array(await readFile(sample.file)),
          sha256: invoice.sha256,
          qrPayload: qr.payload!,
        });

        const mismatches = withQr.invoice.issues.filter((i) => i.code === 'qr-mismatch');
        expect(mismatches, `二维码/文字层不一致：${JSON.stringify(mismatches)}`).toEqual([]);

        expect(withQr.invoice.invoiceNo).toBe(invoice.invoiceNo);
        expect(withQr.invoice.total).toBe(invoice.total);
        expect(withQr.invoice.issueDate).toBe(invoice.issueDate);

        expect(withQr.invoice.provenance.invoiceNo?.source).toBe('qr');
        expect(withQr.invoice.provenance.total?.source).toBe('qr');
        // 二维码里没有销售方，票种也不该被它改掉（通行费票据的票种比「普票」更有用）
        expect(withQr.invoice.sellerName).toBe(invoice.sellerName);
        expect(withQr.invoice.kind).toBe(invoice.kind);
      });
    });
  }
});
