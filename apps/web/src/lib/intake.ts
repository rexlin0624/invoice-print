/**
 * 收票：把用户拖进来的 File 变成 Invoice。
 *
 * 支持的入口（M1）：拖放 / 批量选择 / 压缩包。
 * 压缩包只展开一层，展开后逐张走同一条解析链路。
 */

import type { FileFormat, Invoice, OcrPageInput } from '@invoice-tool/core';
import {
  expandArchive,
  isOfdArchive,
  parseInvoiceFile,
  printablePages,
  sniffFormat,
} from '@invoice-tool/core';

import type { Box } from './box';
import { sha256Hex } from './sha256';
import { OCR_TIMEOUT_MS, QR_TIMEOUT_MS, withTimeout } from './timeout';

/** 一张票在应用里需要的一切（内核的 Invoice + 外壳持有的原始字节） */
export interface IntakeItem {
  id: string;
  invoice: Invoice;
  /** 原始文件字节。PDF 用于嵌入打印；其他格式只做留存。 */
  data: Uint8Array;
  /**
   * 票面长什么样 —— 决定预览怎么画、打印怎么嵌。
   * - `pdf`：矢量内嵌（保真，最佳）
   * - `image`：栅格内嵌
   * - `none`：没有票面（XML / OFD 的结构化数据），预览用信息卡
   */
  visual: 'pdf' | 'image' | 'none';
  /** 图片的 MIME（visual === 'image' 时才有） */
  imageMime?: string;
  /** 能不能嵌进打印 PDF（`visual !== 'none'`） */
  embeddable: boolean;
  /** 内容原始尺寸（pt） */
  width: number;
  height: number;
  /**
   * 裁掉白边后的内容区域（源文件页面坐标，pt）。
   * 三态，别合并：
   * - `undefined` = **还没探测过**（MergePrint 的 effect 据此决定要不要跑探测）
   * - `null` = **探测过、不需要裁**（整页留白正常 / 覆盖率异常拒绝裁 / 探测失败）
   * - `Box` = 要裁到这个框
   *
   * 坑：早先只有 `undefined` 表示「不裁」，于是「探测过但不裁」和「没探测」
   * 无法区分 —— effect 的依赖每轮都判定「还有没探测的票」，无限重跑探测、
   * 进度条永远停在「正在识别白边…」。见 `lib/raster.ts` 的 `detectContentBox`。
   */
  crop?: Box | null;
}

export interface IntakeProgress {
  done: number;
  total: number;
  name: string;
  /** 当前这一张正在做什么（OCR 比较慢，必须说明白） */
  note?: string;
}

export interface IntakeOptions {
  concurrency?: number;
  onProgress?: (p: IntakeProgress) => void;
  /** 这张票当前在做什么（OCR 很慢，必须让用户看到进度） */
  onNote?: (note: string | undefined) => void;
  /** 扫描件/图片是否跑本机 OCR（默认开） */
  ocr?: boolean;
}

const MAX_ARCHIVE_ENTRIES = 200;

/** OCR 要读的页上限：一张扫描件多页票全认会非常慢，前几页足够取出票面字段 */
const MAX_OCR_PAGES = 3;

async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** 图片的 MIME：只认魔数，不信扩展名（和 `sniffFormat` 一个脾气） */
function imageMime(data: Uint8Array): string {
  return data[0] === 0x89 && data[1] === 0x50 ? 'image/png' : 'image/jpeg';
}

/**
 * 尽量解出二维码原文。
 *
 * - **只对 PDF 与图片做**：OFD / XML 走出来的是结构化数据，二维码给不了更多；
 *   OFD 里的二维码是矢量绘制，要渲染 OFD 页面才能读，M1 不做。
 * - **动态 import**：zxing 的 JS + wasm 有 1 MB 级，首屏不该为它买单。
 *   首次导入发票时才拉这个 chunk。
 * - **永不抛，也永不卡住**：解不出来/超时都当没有，退化成「只有文字层」的正常路径。
 *   超时是必须的 —— 标签页在后台时渲染会被浏览器限流，可以慢到分钟级（见 `timeout.ts`）。
 */
async function readQr(format: FileFormat, data: Uint8Array): Promise<string | undefined> {
  if (format !== 'pdf' && format !== 'image') return undefined;
  try {
    const { decodeQrFromPdf, decodeQrFromImage } = await import('./qr');
    const decoded = await withTimeout(
      format === 'pdf' ? decodeQrFromPdf(data) : decodeQrFromImage(data, imageMime(data)),
      QR_TIMEOUT_MS,
      '二维码解码',
    );
    return decoded ?? undefined;
  } catch (err) {
    console.warn('[intake] 二维码解码失败，按「只有文字层」继续：', err);
    return undefined;
  }
}

/**
 * 这张票需不需要跑 OCR。
 *
 * 只对**图片**和**没有文字层的 PDF** 跑 —— 有文字层时文字层（0.85）永远压过
 * OCR（0.6），跑一遍纯属浪费几十秒。这个判断靠第一次解析的结论，
 * 不靠猜文件大小或扩展名。
 */
function needsOcr(format: FileFormat, outcome: Awaited<ReturnType<typeof parseInvoiceFile>>): boolean {
  if (format === 'image') return true;
  if (format !== 'pdf') return false;
  // 第一次解析时 document 就是真文字层（OCR 还没跑）
  return outcome.document !== undefined && !outcome.document.hasText;
}

/**
 * 跑 OCR。**这个函数永不抛**，也永不返回「半个结果」：
 * 拿不到就返回 undefined，让这一张按「没有文字层」的原样继续。
 *
 * 模型没装时往 invoice 里塞一条 warn，把话说清楚 ——
 * 否则用户只会看到「销售方未识别」，不知道是没装模型。
 */
async function runOcr(
  format: FileFormat,
  data: Uint8Array,
  outcome: Awaited<ReturnType<typeof parseInvoiceFile>>,
  onNote?: (note: string | undefined) => void,
): Promise<OcrPageInput[] | undefined> {
  try {
    const { ocrAssetsReady, recognizeImage, recognizePdfPages } = await import('./ocr');

    if (!(await ocrAssetsReady())) {
      outcome.invoice.issues.push({
        code: 'ocr-unavailable',
        level: 'warn',
        message:
          '这台电脑还没装离线 OCR 中文模型，扫描件与图片只能从二维码取到号码、金额和日期。装一次即可（说明见「更多设置」）。',
      });
      return undefined;
    }

    const report = (label: string): void => {
      onNote?.(`${label}（本机离线识别，比文字层慢）`);
    };

    /** 超时/失败都走这里：说清楚「跳过了」，别让用户以为是识别不出来 */
    const giveUp = (): undefined => {
      outcome.invoice.issues.push({
        code: 'ocr-timeout',
        level: 'info',
        message:
          '本机 OCR 没能在合理时间内给出结果，已跳过（窗口切到后台时浏览器会限流渲染，切到前台重试通常就好）。',
      });
      return undefined;
    };

    if (format === 'image') {
      const page = await withTimeout(
        recognizeImage(data, (p) => report(p.label)),
        OCR_TIMEOUT_MS,
        'OCR 识别（图片）',
      );
      if (page === undefined) return giveUp();
      return page.tokens.length > 0 ? [page] : undefined;
    }

    // 只认前几页：扫描件多页全认会非常慢，而票面字段基本都在第一页
    const pages = printablePages(outcome.invoice).slice(0, MAX_OCR_PAGES);
    if (pages.length === 0) return undefined;
    const recognized = await withTimeout(
      recognizePdfPages(data, pages, (p) => report(p.label)),
      OCR_TIMEOUT_MS,
      'OCR 识别（PDF）',
    );
    if (recognized === undefined) return giveUp();
    const usable = recognized.filter((page) => page.tokens.length > 0);
    return usable.length > 0 ? usable : undefined;
  } catch (err) {
    console.warn('[intake] OCR 失败，按原有结果继续：', err);
    return undefined;
  } finally {
    onNote?.(undefined);
  }
}

/** 单张（已拿到字节）→ IntakeItem */
async function parseOne(
  name: string,
  data: Uint8Array,
  options: IntakeOptions = {},
): Promise<IntakeItem> {
  // 先判定格式：这一步要在解析之前做完，
  // 因为解析器（pdfjs）可能把字节转移走，之后就读不到了。
  const format = sniffFormat(name, data);
  const visual: IntakeItem['visual'] =
    format === 'pdf' ? 'pdf' : format === 'image' ? 'image' : 'none';
  const embeddable = visual !== 'none';
  const sha256 = await sha256Hex(data);
  const id = crypto.randomUUID();

  // 二维码要在解析之前解出来（它也得吃 pdfjs），随后作为更高可信度来源注入内核。
  const qrPayload = await readQr(format, data);
  const input = {
    id,
    fileName: name,
    data,
    sha256,
    ...(qrPayload !== undefined ? { qrPayload } : {}),
  };

  let outcome = await parseInvoiceFile(input);

  // ---- 没有文字层就上 OCR（M3）。这里是「能拿到多少就多少」的位置：
  // OCR 失败、模型没装、用户关了开关，都不影响这一张继续往下走。
  if ((options.ocr ?? true) && needsOcr(format, outcome)) {
    const ocrPages = await runOcr(format, data, outcome, options.onNote);
    if (ocrPages !== undefined) {
      // 带上 OCR 页重新解析一次：内核按阶梯合并，文字层路径完全不变
      outcome = await parseInvoiceFile({ ...input, ocrPages });
    }
  }

  // 图片没有 pt 尺寸，用它的像素尺寸（排版只需要比例正确）
  let size = outcome.contentSize;
  if (size === undefined && format === 'image') {
    const { imageSize } = await import('./raster');
    size = await imageSize(data).catch(() => undefined);
  }
  const finalSize = size ?? { width: 595.28, height: 396.85 };

  return {
    id,
    invoice: outcome.invoice,
    data,
    visual,
    ...(visual === 'image' ? { imageMime: imageMime(data) } : {}),
    embeddable,
    width: finalSize.width,
    height: finalSize.height,
  };
}

/** 一个 File → 若干 IntakeItem（压缩包会展开成多张） */
async function intakeOne(file: File, options: IntakeOptions): Promise<IntakeItem[]> {
  const data = await fileToBytes(file);

  if (sniffFormat(file.name, data) === 'zip' && !(await isOfdArchive(data))) {
    const entries = await expandArchive(data);
    const picked = entries.slice(0, MAX_ARCHIVE_ENTRIES);
    const out: IntakeItem[] = [];
    for (const entry of picked) {
      out.push(await parseOne(entry.name, entry.data, options));
    }
    return out;
  }

  return [await parseOne(file.name, data, options)];
}

/**
 * 并发上限。
 *
 * 没有 OCR 时用 3：解析本身不重，但 pdfjs 渲染/解码会吃内存。
 * 开了 OCR 就压到 1 —— tesseract 的 worker 只有一个（共用），
 * 而且每张都要渲染一整页画布，几个并发就是几百 MB。
 */
function resolveConcurrency(requested: number | undefined, ocr: boolean): number {
  if (requested !== undefined) return Math.max(1, requested);
  return ocr ? 1 : 3;
}

/** 并发受限的批量收票。默认 3 并发：解析本身不重，但 pdfjs 渲染/解码会吃内存。 */
async function runQueue<T>(
  count: number,
  concurrency: number,
  work: (index: number) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      results.push(...(await work(index)));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, worker));
  return results;
}

export async function intakeFiles(
  files: readonly File[],
  options: IntakeOptions = {},
): Promise<IntakeItem[]> {
  const { onProgress, ocr = true } = options;
  const concurrency = resolveConcurrency(options.concurrency, ocr);
  const total = files.length;
  let done = 0;

  const work = async (index: number): Promise<IntakeItem[]> => {
    const file = files[index]!;
    let note: string | undefined;
    const emit = (): void => {
      onProgress?.({ done, total, name: file.name, ...(note !== undefined ? { note } : {}) });
    };
    emit();
    const onNote = (next: string | undefined): void => {
      note = next;
      emit();
    };
    try {
      return await intakeOne(file, { ocr, onNote });
    } catch (err) {
      return [failedItem(file.name, file.size, err)];
    } finally {
      done += 1;
    }
  };

  return runQueue(total, concurrency, work);
}

/**
 * 从字节收票（已报销库「加入本次导入」用）。
 * 与 `intakeFiles` 共用同一套流程，所以重复跳过、校验、二维码、OCR 都照常生效。
 */
export async function intakeBytes(
  entries: readonly { name: string; data: Uint8Array }[],
  options: IntakeOptions = {},
): Promise<IntakeItem[]> {
  const { onProgress, ocr = true } = options;
  const concurrency = resolveConcurrency(options.concurrency, ocr);
  const total = entries.length;
  let done = 0;

  const work = async (index: number): Promise<IntakeItem[]> => {
    const entry = entries[index]!;
    let note: string | undefined;
    const emit = (): void => {
      onProgress?.({ done, total, name: entry.name, ...(note !== undefined ? { note } : {}) });
    };
    emit();
    const onNote = (next: string | undefined): void => {
      note = next;
      emit();
    };
    try {
      return [await parseOne(entry.name, entry.data, { ocr, onNote })];
    } catch (err) {
      return [failedItem(entry.name, entry.data.byteLength, err)];
    } finally {
      done += 1;
    }
  };

  return runQueue(total, concurrency, work);
}

/** 单张失败不能拖垮整批：造一张带 error 的占位票，让用户看到是哪张有问题 */
function failedItem(name: string, size: number, err: unknown): IntakeItem {
  const message = err instanceof Error ? err.message : String(err);
  return {
    id: crypto.randomUUID(),
    invoice: {
      id: crypto.randomUUID(),
      fileName: name,
      fileSize: size,
      sha256: '',
      kind: 'unknown',
      items: [],
      pageCount: 1,
      provenance: {},
      issues: [{ code: 'parse-failed', level: 'error', message }],
    },
    data: new Uint8Array(),
    visual: 'none',
    embeddable: false,
    width: 595.28,
    height: 396.85,
  };
}
