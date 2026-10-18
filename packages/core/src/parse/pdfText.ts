/**
 * PDF 文字层解析（pdfjs-dist）。
 *
 * 为什么用 pdfjs 而不是自己写 PDF 解析器：字体 /ToUnicode CMap 解码、Identity-H
 * 编码、CTM 与文本矩阵变换、旋转页……这些都是 pdfjs 十几年打磨过的东西。
 * 自己实现等于重走一遍所有坑。
 *
 * 本模块只做「PDF 字节 → 结构化文字层」，不渲染、不依赖 DOM。
 */

import type { DocumentText, PageText, TextToken } from '../text/lines';
import { buildDocumentText, buildPageText } from '../text/lines';

// pdfjs 的极简结构类型。刻意不引它的 d.ts：内核不该被某个版本的内部类型绑死。
interface PdfJsTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}
interface PdfJsViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}
interface PdfJsPage {
  getViewport(params: { scale: number }): PdfJsViewport;
  getTextContent(params?: unknown): Promise<{ items: unknown[] }>;
}
interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  destroy(): Promise<void>;
}
interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: unknown): { promise: Promise<PdfJsDocument> };
}

let modulePromise: Promise<PdfJsModule> | undefined;
let pendingWorkerSrc: string | undefined;

async function loadPdfjs(): Promise<PdfJsModule> {
  if (!modulePromise) {
    modulePromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
      const mod = m as unknown as PdfJsModule;
      if (pendingWorkerSrc !== undefined) mod.GlobalWorkerOptions.workerSrc = pendingWorkerSrc;
      return mod;
    });
  }
  return modulePromise;
}

/**
 * 由外壳注入 worker 地址（浏览器里必设；Node 里不需要）。
 * 例：`setPdfWorkerSrc(new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href)`
 */
export function setPdfWorkerSrc(src: string): void {
  pendingWorkerSrc = src;
  if (modulePromise) {
    void modulePromise.then((m) => {
      m.GlobalWorkerOptions.workerSrc = src;
    });
  }
}

export interface PdfTextOptions {
  password?: string;
  /** 最多解析多少页，默认 20 —— 发票不需要更多 */
  maxPages?: number;
}

function isTextItem(v: unknown): v is PdfJsTextItem {
  return typeof v === 'object' && v !== null && 'str' in v;
}

/**
 * 解析 PDF 字节流 → 结构化文字层。
 * 不抛异常：出错时返回空结果并带上原因。
 */
export async function parsePdfText(
  data: Uint8Array,
  options: PdfTextOptions = {},
): Promise<{ document: DocumentText; error?: string; pageCount: number }> {
  const { password, maxPages = 20 } = options;

  let doc: PdfJsDocument | undefined;
  try {
    const pdfjs = await loadPdfjs();
    // ⚠️ pdfjs 会把 `data` 的 ArrayBuffer **转移**（transfer）给它的 worker，
    // 转移之后调用方手里的 Uint8Array 就变成 detached，再碰一下就抛
    // `Cannot perform Construct on a detached ArrayBuffer`。
    // 这个坑只在浏览器里出现（Node 里没有 worker，不会转移），
    // 所以「Node 测试全绿、浏览器全空」是本项目最容易踩的一类 bug。
    // 内核不改调用方的内存：先拷一份再交出去。
    const params: Record<string, unknown> = {
      data: data.slice(),
      // 文字层提取不需要字体栅格化，也不需要 eval
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    };
    if (password !== undefined) params.password = password;

    doc = await pdfjs.getDocument(params).promise;

    const pages: PageText[] = [];
    const limit = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= limit; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const tokens: TextToken[] = [];
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        const str = typeof item.str === 'string' ? item.str : '';
        if (str.trim() === '') continue;
        const transform = Array.isArray(item.transform)
          ? (item.transform as number[])
          : undefined;
        if (!transform || transform.length < 6) continue;

        const tx = Number(transform[4]);
        const ty = Number(transform[5]);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;

        // 交给 viewport 做坐标变换（自动处理 /Rotate），得到 y 向下的页面坐标
        const [vx, vy] = viewport.convertToViewportPoint(tx, ty);

        tokens.push({
          text: str,
          x: Number(vx),
          y: Number(vy),
          width: Number(item.width ?? 0),
          height: Number(item.height ?? 0),
        });
      }

      pages.push(buildPageText(n - 1, viewport.width, viewport.height, tokens));
    }

    return { document: buildDocumentText(pages), pageCount: doc.numPages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      document: buildDocumentText([]),
      error: message,
      pageCount: doc?.numPages ?? 0,
    };
  } finally {
    try {
      await doc?.destroy();
    } catch {
      /* destroy 失败无所谓 */
    }
  }
}
