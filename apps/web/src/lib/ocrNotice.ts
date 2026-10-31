import type { Issue } from '@invoice-tool/core';

/** 有「OCR 模型没装」问题的票数。关掉 OCR 开关后不再提示。 */
export function ocrMissingCount(
  items: ReadonlyArray<{ invoice: { issues: readonly Issue[] } }>,
  ocrEnabled: boolean,
): number {
  if (!ocrEnabled) return 0;
  let count = 0;
  for (const item of items) {
    if (item.invoice.issues.some((issue) => issue.code === 'ocr-unavailable')) count += 1;
  }
  return count;
}

/**
 * 模型文件的探测响应算不算数。
 * SPA 兜底（Vite dev、history fallback 的静态服务器）会把不存在的路径
 * 回成 200 + index.html，只看 `res.ok` 会把「没装模型」误判成「装了」。
 * 所以回 HTML 一律不算；没有 Content-Type 的二进制响应算可用。
 */
export function ocrAssetResponseIsUsable(ok: boolean, contentType: string | null): boolean {
  if (!ok) return false;
  // MIME type 大小写不敏感（RFC 2045 §5.1），反代可能回 Text/HTML
  if (contentType?.toLowerCase().includes('text/html')) return false;
  return true;
}
