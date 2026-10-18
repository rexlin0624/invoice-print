/**
 * 触发下载（网页版）。集中在一个地方，免得每个页面各写一遍 `a.click()`。
 *
 * 桌面版不走这里：桌面版用系统保存对话框（见 `save.ts`）。
 *
 * CSV 必须带 UTF-8 BOM：不带的话 Windows 版 Excel 会用本地代码页去猜，
 * 中文列名变乱码 —— 这是导出功能最常见的投诉（`saveText` 负责加）。
 */

export function downloadBlob(bytes: Uint8Array, fileName: string, mime: string): void {
  // `bytes.buffer` 可能是被共享的 ArrayBuffer，只切出自己那一段
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
