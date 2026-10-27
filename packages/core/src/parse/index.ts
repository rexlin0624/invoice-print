/**
 * 解析入口：**取数阶梯**。
 *
 *   结构化数据（XML / OFD 内嵌 XML）  >  二维码  >  PDF 文字层  >  OCR
 *
 * 高可信度来源先落，低可信度只补空缺，绝不覆盖已确认的值。
 * 本模块只负责「字节 + 文件名 → Invoice」，不做 I/O。
 */

import JSZip from 'jszip';

import type { Invoice, Issue } from '../model/invoice';
import { MAX_INVOICE_PAGES, makeIssue, SOURCE_CONFIDENCE } from '../model/invoice';
import type { ArchiveLimits } from './limits';
import {
  ArchiveLimitError,
  declaredSize,
  formatMb,
  MAX_XML_BYTES,
  readCapped,
  resolveLimits,
} from './limits';
import type { DocumentText, TextToken } from '../text/lines';
import { buildDocumentText, buildPageText } from '../text/lines';
import type { InvoiceExtraction } from './fields';
import { extractInvoiceFields } from './fields';
import { parseOfd } from './ofd';
import { parsePdfText } from './pdfText';
import { detectMedicalDetailPages } from './medical';
import { parseInvoiceXml } from './xml';
import { crossCheckQr, extractFromQr, kindFromQr, parseQrPayload } from './qr';

export { ArchiveLimitError } from './limits';

export type FileFormat = 'pdf' | 'ofd' | 'xml' | 'zip' | 'image' | 'unknown';

/**
 * 外壳 OCR 出来的一页。
 *
 * 结构与文字层**同构**（尺寸 + 带坐标的 token），这是有意的：
 * 字段提取靠的是「锚点文字 + 相对位置」，它并不在乎 token 是从 PDF 内容流里
 * 抽出来的还是从像素里认出来的。于是 OCR 只需要外壳把像素变成 token，
 * 内核里那套锚点规则**一行都不用改**，两条路径也不会各写一套取数逻辑。
 *
 * 坐标约定与 `PageText` 一致：pt（图片票就是像素），左上原点，y 向下。
 */
export interface OcrPageInput {
  width: number;
  height: number;
  tokens: TextToken[];
}

export interface ParseInput {
  id: string;
  fileName: string;
  data: Uint8Array;
  /** 由外壳算好（Web Crypto / Rust） */
  sha256: string;
  importedAt?: number;
  /**
   * 外壳解出的**二维码原文**。
   *
   * 为什么由外壳注入：把图像变成字符串需要栅格化 + WASM，属外壳能力
   * （见 `apps/web/src/lib/qr.ts`）；内核只认字符串，保持零 DOM。
   *
   * 注意：**执行顺序 ≠ 优先级顺序**。二维码要先栅格化才能读，成本高，
   * 所以实际是「文字层先跑、二维码后跑」，但合并时二维码的置信度（0.95）
   * 高于文字层（0.85），仍按阶梯取胜。
   */
  qrPayload?: string;
  /**
   * 外壳 OCR 出来的页（M3）。只在**没有文字层**时才会被用到 ——
   * 有文字层时文字层（0.85）永远压过 OCR（0.6），所以外壳没必要为它白跑一遍。
   */
  ocrPages?: OcrPageInput[];
}

export interface ParseOutcome {
  invoice: Invoice;
  /** 文字层（PDF/OFD 才有），供 UI 的「文字层」视图使用 */
  document?: DocumentText;
  /** 原始内容的物理尺寸（pt），排版用 */
  contentSize?: { width: number; height: number };
  error?: string;
}

/** 按魔数 + 扩展名判断格式。不信扩展名，只看内容。 */
export function sniffFormat(fileName: string, data: Uint8Array): FileFormat {
  const head = data.subarray(0, 6);
  const ascii = String.fromCharCode(...head);

  if (ascii.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) return 'zip'; // PK\x03\x04
  if (head[0] === 0xff && head[1] === 0xd8) return 'image'; // jpeg
  if (head[0] === 0x89 && head[1] === 0x50) return 'image'; // png
  if (head[0] === 0x42 && head[1] === 0x4d) return 'image'; // bmp

  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ofd')) return 'ofd';
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.pdf')) return 'pdf';

  // 文本型 XML：允许 BOM 与前置空白
  const text = new TextDecoder().decode(data.subarray(0, 512)).trimStart().replace(/^\uFEFF/, '');
  if (text.startsWith('<?xml') || text.startsWith('<Invoice') || text.startsWith('<EInvoice')) return 'xml';

  return 'unknown';
}

/** ZIP 是不是 OFD 包（OFD 就是一个带 OFD.xml 的 zip） */
export async function isOfdArchive(data: Uint8Array): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(data);
    return Object.keys(zip.files).some((n) => /(^|\/)OFD\.xml$/i.test(n));
  } catch {
    return false;
  }
}

export interface ArchiveEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 展开压缩包（只取一层，不支持嵌套压缩包）。挑出可能是发票的文件。
 *
 * **预算在执行前就定好**：先看中央目录声明的解压后大小，再流式解压并累计总字节。
 * 旧实现是「全部解压完再截断 200 条」，一个几 MB 的压缩炸弹就能把标签页撑爆 ——
 * 而这条路径收的正是陌生人给的包。
 *
 * 超过单条/总预算时抛 `ArchiveLimitError`；超过条数上限时**只展开前 N 条**，
 * 与旧行为一致（用户要是真给了 300 张，至少能先把前 200 张处理完）。
 */
export async function expandArchive(
  data: Uint8Array,
  limits: ArchiveLimits = {},
): Promise<ArchiveEntry[]> {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = resolveLimits(limits);
  const zip = await JSZip.loadAsync(data);
  const out: ArchiveEntry[] = [];
  let total = 0;
  const names = Object.keys(zip.files).sort();

  for (const name of names) {
    if (out.length >= maxEntries) break;
    const file = zip.files[name];
    if (!file || file.dir) continue;
    if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue;
    if (!/\.(pdf|ofd|xml|jpg|jpeg|png)$/i.test(name)) continue;

    const declared = declaredSize(file);
    if (declared !== undefined && declared > maxEntryBytes) {
      throw new ArchiveLimitError(
        `压缩包里的「${name.split('/').pop() ?? name}」解压后约 ${formatMb(declared)}，` +
          `超过单张 ${formatMb(maxEntryBytes)} 的上限，已取消导入。`,
      );
    }

    const budget = Math.min(maxEntryBytes, maxTotalBytes - total);
    if (budget <= 0) {
      throw new ArchiveLimitError(
        `压缩包解压后超过 ${formatMb(maxTotalBytes)} 的上限，已取消导入。`,
      );
    }

    const bytes = await readCapped(file, budget);
    if (bytes === undefined) {
      throw new ArchiveLimitError(
        `压缩包解压后超过 ${formatMb(maxTotalBytes)} 的上限（或单个文件超过 ` +
          `${formatMb(maxEntryBytes)}），已取消导入。`,
      );
    }

    total += bytes.byteLength;
    out.push({ name: name.split('/').pop() ?? name, data: bytes });
  }

  return out;
}

/** 把一次抽取的结果合并进 Invoice。凭**置信度阶梯**决定谁覆盖谁。 */
function mergeExtraction(
  invoice: Invoice,
  extraction: InvoiceExtraction | { fields: Partial<Invoice>; confidence: Partial<Record<keyof Invoice, number>>; anchors: Record<string, string>; issues: Issue[] },
  source: 'xml' | 'ofd' | 'qr' | 'pdf-text' | 'ocr',
): void {
  for (const [key, value] of Object.entries(extraction.fields)) {
    if (value === undefined) continue;
    const field = key as keyof Invoice;

    /**
     * 字段级置信度**只能往下压，不能往上抬**。
     *
     * 抽取器会给「锚点匹配得很实」的字段打 0.9，但那是「就版式而言很确定」，
     * 不代表来源可信：OCR 认出来的 0.9 绝不能和文字层的 0.85 平起平坐，
     * 否则阶梯就失效了。所以这里用 `min(字段置信度, 来源置信度)`。
     */
    const sourceConfidence = SOURCE_CONFIDENCE[source];
    const override = extraction.confidence[field];
    const confidence = override === undefined ? sourceConfidence : Math.min(override, sourceConfidence);

    // 占位值（kind 的 'unknown'）允许被覆盖
    const isPlaceholder = field === 'kind' && invoice.kind === 'unknown';
    const existing = invoice.provenance[field];

    // ⚠️ 这里**必须**先比置信度再决定跳不跳。
    // 曾经写的是「已有值就直接 continue」，那句话让下面的阶梯判断变成死代码：
    // 二维码（0.95）永远盖不过先跑的 PDF 文字层（0.85），阶梯名存实亡。
    if (invoice[field] !== undefined && field !== 'items' && !isPlaceholder) {
      if (existing === undefined || existing.confidence >= confidence) continue;
    }

    (invoice as unknown as Record<string, unknown>)[field] = value;
    invoice.provenance[field] = { source, confidence };
  }
  invoice.issues.push(...extraction.issues);
}

function emptyInvoice(input: ParseInput): Invoice {
  return {
    id: input.id,
    fileName: input.fileName,
    fileSize: input.data.byteLength,
    sha256: input.sha256,
    kind: 'unknown',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...(input.importedAt !== undefined ? { importedAt: input.importedAt } : {}),
  };
}

/** OCR 提示语：说清楚「识别过」与「要重点核对」，别让用户以为拿到了文字层级别的准确率 */
const OCR_NOTE =
  '这个文件没有文字层，已在本机做离线 OCR 识别。号码、金额这类关键字段请对照票面复核（OCR 准确率低于文字层）。';

/** 外壳送进来的 OCR 页 → 内核的 PageText（与文字层同构，后续规则完全复用） */
function ocrDocument(input: ParseInput): DocumentText | undefined {
  const pages = input.ocrPages;
  if (!pages || pages.length === 0) return undefined;
  const built = pages.map((page, index) => buildPageText(index, page.width, page.height, page.tokens));
  const document = buildDocumentText(built);
  return document.hasText ? document : undefined;
}

/** 主入口。不抛异常：任何失败都体现在 invoice.issues 里。 */
export async function parseInvoiceFile(input: ParseInput): Promise<ParseOutcome> {
  const invoice = emptyInvoice(input);
  let format = sniffFormat(input.fileName, input.data);

  if (format === 'zip') {
    format = (await isOfdArchive(input.data)) ? 'ofd' : 'zip';
  }

  /**
   * 应用二维码：**补空缺 + 交叉校验**。
   *
   * 必须在每个 return 之前调用（PDF / OFD 分支都是提前 return 的）。
   * 先记下文字层的值，合并之后再拿它们和二维码比 —— 否则拿合并后的值去比，
   * 等于自己跟自己比，永远一致。
   */
  const applyQr = (): void => {
    if (input.qrPayload === undefined) return;
    const payload = parseQrPayload(input.qrPayload);
    if (!payload) return;

    const fromPage = {
      invoiceNo: invoice.invoiceNo,
      total: invoice.total,
      issueDate: invoice.issueDate,
      kind: invoice.kind,
    };

    mergeExtraction(invoice, extractFromQr(payload), 'qr');

    // 文字层没判出票种时，让二维码补一个粗分类（代码表未验证的票种不参与）
    if (invoice.kind === 'unknown') {
      const kind = kindFromQr(payload);
      if (kind) {
        invoice.kind = kind;
        invoice.provenance.kind = { source: 'qr', confidence: SOURCE_CONFIDENCE.qr };
      }
    }

    invoice.issues.push(...crossCheckQr(payload, fromPage));
  };

  try {
    switch (format) {
      case 'xml': {
        if (input.data.byteLength > MAX_XML_BYTES) {
          invoice.issues.push(
            makeIssue(
              'file-too-large',
              'warn',
              `XML 文件超过 ${formatMb(MAX_XML_BYTES)}，已跳过解析。`,
            ),
          );
          break;
        }
        const text = new TextDecoder().decode(input.data);
        const result = parseInvoiceXml(text);
        mergeExtraction(invoice, result, 'xml');
        break;
      }

      case 'ofd': {
        const result = await parseOfd(input.data);
        // 先把诊断信息收进来：翻页上限、附件读不了之类的提示，在成功路径上也要看得见
        invoice.issues.push(...result.issues);
        if (result.xml) {
          mergeExtraction(invoice, result.xml, 'ofd');
        }
        if (result.pages.length > 0) {
          const extraction = extractInvoiceFields(result.pages);
          mergeExtraction(invoice, extraction, 'pdf-text');
          const first = result.pages[0]!;
          invoice.pageCount = Math.min(result.pages.length, MAX_INVOICE_PAGES);
          applyQr();
          return {
            invoice,
            document: buildDocumentText(result.pages),
            contentSize: { width: first.width, height: first.height },
          };
        }
        break;
      }

      case 'pdf': {
        const { document, error, pageCount } = await parsePdfText(input.data);
        if (error !== undefined) {
          invoice.issues.push(makeIssue('parse-failed', 'error', `PDF 文字层解析失败：${error}`));
        }
        // `/Count` 是文件自己说的，不能直接拿去建数组：后面的预览、排版、打印都按它展开。
        const declaredPages = Number.isFinite(pageCount) ? Math.trunc(pageCount) : 0;
        invoice.pageCount = Math.min(Math.max(declaredPages, 1), MAX_INVOICE_PAGES);
        if (declaredPages > MAX_INVOICE_PAGES) {
          invoice.issues.push(
            makeIssue(
              'page-count-clamped',
              'warn',
              `PDF 声明了 ${declaredPages} 页，超过 ${MAX_INVOICE_PAGES} 页的上限，只按前 ${MAX_INVOICE_PAGES} 页处理。`,
            ),
          );
        }

        /** 没有文字层时的兜底文档（OCR 的结果），用于取字段与预览 */
        const fallback = document.hasText ? undefined : ocrDocument(input);

        if (document.hasText) {
          mergeExtraction(invoice, extractInvoiceFields(document.pages), 'pdf-text');
        } else if (fallback) {
          // 扫描件：OCR 的置信度（0.6）低于文字层，但总比什么都没有强
          mergeExtraction(invoice, extractInvoiceFields(fallback.pages), 'ocr');
          invoice.issues.push(makeIssue('ocr-used', 'info', OCR_NOTE));
        } else {
          // 既没有文字层也没有 OCR（外壳没跑或跑失败）：二维码仍可能解出号码 / 金额 / 日期
          const qr = input.qrPayload === undefined ? undefined : parseQrPayload(input.qrPayload);
          invoice.issues.push(
            qr
              ? makeIssue(
                  'qr-only',
                  'info',
                  '这个 PDF 没有可用的文字层（多半是扫描件）。已用二维码取到发票号码、价税合计与开票日期；其余字段需要 OCR。',
                )
              : makeIssue(
                  'no-text-layer',
                  'warn',
                  '这个 PDF 没有可用的文字层（多半是扫描件/图片），需要 OCR 才能取字段。',
                ),
          );
        }

        // 医疗票据的明细页不报销、尺寸也不同 —— 剔掉（判据与安全边界见 parse/medical.ts）。
        // 只在真文字层上判：OCR 的坐标精度不够，用它判会误剔整页。
        const detailPages = document.hasText ? detectMedicalDetailPages(document.pages) : [];
        if (detailPages.length > 0) {
          invoice.skipPages = detailPages;
          invoice.issues.push(
            makeIssue(
              'detail-page-skipped',
              'info',
              `已跳过第 ${detailPages.map((i) => i + 1).join('、')} 页：判断为医疗收费明细页（不随票报销）。如判断有误，可在「更多设置」里改为全部打印。`,
            ),
          );
        }

        const usable = document.hasText ? document : (fallback ?? document);
        const first = usable.pages[0];
        applyQr();
        return {
          invoice,
          document: usable,
          ...(first ? { contentSize: { width: first.width, height: first.height } } : {}),
          ...(error !== undefined ? { error } : {}),
        };
      }

      case 'zip': {
        invoice.issues.push(
          makeIssue('unsupported-format', 'info', '这是一个压缩包，已由外壳展开后逐张解析。'),
        );
        break;
      }

      case 'image': {
        // 图片：先看 OCR（能取到销售方等全套字段），不行再退回二维码
        const fallback = ocrDocument(input);
        if (fallback) {
          mergeExtraction(invoice, extractInvoiceFields(fallback.pages), 'ocr');
          invoice.issues.push(makeIssue('ocr-used', 'info', OCR_NOTE));
          const first = fallback.pages[0];
          applyQr();
          return {
            invoice,
            document: fallback,
            ...(first ? { contentSize: { width: first.width, height: first.height } } : {}),
          };
        }

        const qr = input.qrPayload === undefined ? undefined : parseQrPayload(input.qrPayload);
        invoice.issues.push(
          qr
            ? makeIssue(
                'qr-only',
                'info',
                '这是图片/扫描件，没有文字层。已用二维码取到发票号码、价税合计与开票日期；其余字段需要 OCR。',
              )
            : makeIssue(
                'unsupported-format',
                'warn',
                '图片/扫描件需要离线 OCR，当前没有可用的识别结果。',
              ),
        );
        break;
      }

      default: {
        invoice.issues.push(
          makeIssue('unsupported-format', 'error', `无法识别的文件类型：${input.fileName}`),
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    invoice.issues.push(makeIssue('parse-failed', 'error', `解析时发生异常：${message}`));
  }

  // 即使文字层挂了，二维码仍可能给出号码/金额/日期
  applyQr();
  return { invoice };
}
