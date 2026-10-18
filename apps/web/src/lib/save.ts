/**
 * 保存：**网页版走下载，桌面版走系统保存对话框**。
 *
 * 页面只调 `saveBytes` / `saveText`，不判断自己跑在哪儿 —— 判断只在这里做一次。
 * 这样「桌面版存到哪」这种问题不会渗进每个页面。
 *
 * 网页版存到哪儿由浏览器的下载设置决定，前端**不知道也猜不到**，所以
 * `SaveOutcome.path` 只有桌面端才有值；页面据此决定要不要给「在文件夹里显示」。
 */

import { downloadBlob } from './download';
import { isDesktop, logLine, revealPath, saveDocument } from './shell';

export interface SaveOutcome {
  saved: boolean;
  /** 用户在对话框里取消了 —— 不算失败，别弹错误 */
  canceled?: boolean;
  /** 桌面端才有：存到了哪个路径 */
  path?: string;
  name: string;
}

export interface SaveOptions {
  /** Blob 的 MIME 类型（网页版用） */
  mime?: string;
  /** 桌面端保存对话框的扩展名，逗号分隔：`pdf` / `xlsx` / `csv` */
  filter?: string;
  /** 文本是否加 UTF-8 BOM（默认加：CSV 不加的话 Windows 版 Excel 中文会乱码） */
  bom?: boolean;
}

export async function saveBytes(
  bytes: Uint8Array,
  fileName: string,
  options: SaveOptions = {},
): Promise<SaveOutcome> {
  try {
    if (isDesktop()) {
      const written = await saveDocument(bytes, fileName, options.filter);
      if (!written) return { saved: false, canceled: true, name: fileName };
      logLine(`save ok: ${written.path} (${written.size} B)`);
      return { saved: true, path: written.path, name: written.name };
    }

    downloadBlob(bytes, fileName, options.mime ?? 'application/octet-stream');
    return { saved: true, name: fileName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`save failed: ${fileName} ${message}`);
    throw err;
  }
}

export async function saveText(
  text: string,
  fileName: string,
  options: SaveOptions = {},
): Promise<SaveOutcome> {
  const payload = options.bom === false ? text : `\ufeff${text}`;
  return saveBytes(new TextEncoder().encode(payload), fileName, {
    mime: 'text/csv;charset=utf-8',
    ...options,
  });
}

/** 「在文件夹里显示」：非桌面端是空操作（网页版没有文件路径这回事） */
export function revealSaved(path: string | undefined): void {
  if (!path || !isDesktop()) return;
  void revealPath(path).catch(() => undefined);
}
