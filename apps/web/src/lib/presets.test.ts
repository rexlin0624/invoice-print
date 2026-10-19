/**
 * 排版预设的回归。
 *
 * 关键是 `sanitize`：预设是「读回来直接进排版」的东西，而 localStorage 里的内容
 * 可能是上个版本写的、也可能被手改过。**脏预设绝不能绕过设置白名单**，
 * 否则会出现「设置里写着每页 2 张，实际只摆了 1 张」这种查无可查的问题。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYOUT_SETTINGS } from '@invoice-tool/core';

import { MAX_PRESETS, describePreset, sanitize } from './presets';

describe('预设收敛', () => {
  it('缺名字的条目直接丢掉', () => {
    expect(sanitize([{ name: '  ', settings: {}, savedAt: 1 }, { nope: true }, null, 'x'])).toEqual([]);
  });

  it('设置过一遍白名单：perPage 3 回到默认 2', () => {
    const [preset] = sanitize([{ name: '乱写的', settings: { perPage: 3, offsetXMm: 999 }, savedAt: 1 }]);
    expect(preset!.settings.perPage).toBe(2);
    expect(preset!.settings.offsetXMm).toBe(20);
    expect(preset!.settings).toEqual({
      ...DEFAULT_LAYOUT_SETTINGS,
      offsetXMm: 20,
    });
  });

  it('同名保留新的那条', () => {
    const list = sanitize([
      { name: '常用', settings: { perPage: 1 }, savedAt: 1 },
      { name: '常用', settings: { perPage: 4 }, savedAt: 9 },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]!.settings.perPage).toBe(4);
  });

  it('按保存时间倒序，且最多 20 条', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `p${i}`,
      settings: {},
      savedAt: i,
    }));
    const list = sanitize(many);
    expect(list).toHaveLength(MAX_PRESETS);
    expect(list[0]!.name).toBe('p29');
    expect(list.at(-1)!.name).toBe('p10');
  });

  it('savedAt 缺失也能用（当作最旧）', () => {
    const list = sanitize([{ name: '没时间', settings: {} }]);
    expect(list[0]!.savedAt).toBe(0);
  });
});

describe('预设说明文案', () => {
  it('把关键设置写成一行中文', () => {
    const text = describePreset({ ...DEFAULT_LAYOUT_SETTINGS, perPage: 4, blackWhite: true, offsetXMm: 1 });
    expect(text).toContain('每页 4 张');
    expect(text).toContain('裁切线');
    expect(text).toContain('黑白');
    expect(text).toContain('偏移 1/0mm');
  });
});
