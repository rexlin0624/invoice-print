/**
 * 排版预设（命名的一组排版设置）。
 *
 * 为什么值得有：报销季里同一台打印机、同一批纸，用户可能反复在「一页 4 张、裁切线、窄边距」
 * 与「一页 1 张、宽边距、要页码」之间来回切，每次都要点五下开关。存成预设就是一次点选。
 *
 * 两条纪律：
 * 1. **预设用内核的 `normalizeLayoutSettings` 收敛**。localStorage 里的东西可能是上个版本写的、
 *    也可能被手改过；预设是「读回来直接进排版」的，所以在这里必须过一遍白名单，
 *    不能让 `perPage: 3` 这种东西从预设绕回排版。
 * 2. **同名覆盖**，上限 20 条。不覆盖的话用户会得到一堆「常用」「常用 2」「常用 3」。
 */

import type { LayoutSettings } from '@invoice-tool/core';
import { normalizeLayoutSettings } from '@invoice-tool/core';

export interface LayoutPreset {
  name: string;
  settings: LayoutSettings;
  savedAt: number;
}

const KEY = 'invoice-tool.presets.v1';
export const MAX_PRESETS = 20;

function read(): LayoutPreset[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitize(parsed);
  } catch {
    return [];
  }
}

function write(list: readonly LayoutPreset[]): LayoutPreset[] {
  const kept = list.slice(0, MAX_PRESETS);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* 隐私模式写不进去：本次会话内仍然可用，只是不落盘 */
  }
  return kept;
}

/** 把来路不明的数组收敛成合法预设列表：丢垃圾、去重名、按时间倒序、截断到上限 */
export function sanitize(input: readonly unknown[]): LayoutPreset[] {
  const byName = new Map<string, LayoutPreset>();
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (name === '') continue;
    const savedAt = typeof row.savedAt === 'number' && Number.isFinite(row.savedAt) ? row.savedAt : 0;
    const existing = byName.get(name);
    if (existing && existing.savedAt > savedAt) continue; // 同名保留新的那条
    byName.set(name, { name, settings: normalizeLayoutSettings(row.settings), savedAt });
  }
  return [...byName.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_PRESETS);
}

export function listPresets(): LayoutPreset[] {
  return read();
}

/** 保存（同名覆盖）。返回保存后的完整列表 */
export function savePreset(name: string, settings: LayoutSettings, now = Date.now()): LayoutPreset[] {
  const trimmed = name.trim().slice(0, 24);
  if (trimmed === '') return read();
  const rest = read().filter((p) => p.name !== trimmed);
  return write([{ name: trimmed, settings: normalizeLayoutSettings(settings), savedAt: now }, ...rest]);
}

export function deletePreset(name: string): LayoutPreset[] {
  return write(read().filter((p) => p.name !== name));
}

/** 预设的一句话说明（界面上「4 张 · 横向 · 窄边距 · 黑白」这样） */
export function describePreset(settings: LayoutSettings): string {
  const orientation =
    settings.orientation === 'auto' ? '自动方向' : settings.orientation === 'portrait' ? '竖向' : '横向';
  const margin = { narrow: '窄边距', normal: '标准边距', wide: '宽边距' }[settings.margin];
  const extras = [
    settings.allowRotation ? '允许旋转' : '',
    settings.cutLines ? '裁切线' : '',
    settings.pageNumbers ? '页码' : '',
    settings.cropWhitespace ? '裁白边' : '',
    settings.blackWhite ? '黑白' : '',
    settings.rasterCompat ? '老打印机' : '',
    settings.offsetXMm !== 0 || settings.offsetYMm !== 0
      ? `偏移 ${settings.offsetXMm}/${settings.offsetYMm}mm`
      : '',
  ].filter(Boolean);
  return [`每页 ${settings.perPage} 张`, orientation, margin, ...extras].join(' · ');
}
