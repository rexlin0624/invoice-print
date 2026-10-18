/**
 * 开发期调试入口。只在 `import.meta.env.DEV` 下挂到 window 上，
 * 生产构建会被 tree-shake 掉。用途：在浏览器控制台里直接跑内核，
 * 定位「Node 里能跑、浏览器里跑不通」这类环境差异。
 */

import { parseInvoiceFile, sniffFormat } from '@invoice-tool/core';
import { parsePdfText } from '@invoice-tool/core';

import { decodeQrFromPdf } from './qr';
import { sha256Hex } from './sha256';

export interface DebugApi {
  parseInvoiceFile: typeof parseInvoiceFile;
  parsePdfText: typeof parsePdfText;
  sniffFormat: typeof sniffFormat;
  sha256Hex: typeof sha256Hex;
  /** 从 public/samples 取一个样本的字节 */
  sampleBytes: (name: string) => Promise<Uint8Array>;
  restorePdfWorker: () => Promise<void>;
  /** 解一张样本的二维码原文 */
  decodeQr: (name: string) => Promise<string | undefined>;
}

export function installDebug(): void {
  const api: DebugApi = {
    parseInvoiceFile,
    parsePdfText,
    sniffFormat,
    sha256Hex,
    async sampleBytes(name) {
      const res = await fetch(`/__samples__/${encodeURIComponent(name)}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async restorePdfWorker() {
      const { setPdfWorkerSrc } = await import('@invoice-tool/core');
      const url = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')).default;
      setPdfWorkerSrc(url);
    },
    async decodeQr(name) {
      const bytes = await api.sampleBytes(name);
      return decodeQrFromPdf(bytes);
    },
  };
  (window as unknown as { __invoiceDebug?: DebugApi }).__invoiceDebug = api;
}
