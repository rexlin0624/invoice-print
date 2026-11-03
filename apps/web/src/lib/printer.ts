/**
 * 打印机选择（只有桌面版用得上）。
 *
 * 记住上次选的那台，是这里唯一该做的「状态」：打印机是**机器的属性**，
 * 不是某批票的属性 —— 不该混进排版设置（那玩意儿有排版预设要存/要切换），
 * 也不该每次开应用都重新选一遍。
 */

import type { PrinterList } from './shell';
import { isDesktop, listPrinters } from './shell';

const KEY = 'invoice-tool.printer';

/** 空串 = 「跟随系统」（弹打印对话框） */
export function rememberedPrinter(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberPrinter(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // 隐私模式下 localStorage 会抛。选不了就选不了，别把设置面板搞崩
  }
}

/**
 * 读本机打印机清单。
 *
 * 网页版返回 `null`（没有外壳可问）；桌面版读不到也返回 `null` ——
 * 「没有打印机列表」不是错误，只是这项设置用不了，界面退回「跟随系统」即可。
 */
export async function loadPrinters(): Promise<PrinterList | null> {
  if (!isDesktop()) return null;
  try {
    return await listPrinters();
  } catch (err) {
    console.warn('[printer] 读不到打印机列表：', err);
    return null;
  }
}
