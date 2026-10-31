import { describe, expect, it } from 'vitest';

import { MORE_NAV, PRIMARY_NAV } from './nav-items';

describe('主导航', () => {
  it('查重是第一个一级入口', () => {
    expect(PRIMARY_NAV[0]?.key).toBe('dedupe');
  });

  it('合并打印降为二级入口', () => {
    expect(PRIMARY_NAV.map((item) => item.key)).not.toContain('merge');
    expect(MORE_NAV.map((item) => item.key)).toContain('merge');
  });

  it('凑票也收进更多', () => {
    expect(PRIMARY_NAV.map((item) => item.key)).not.toContain('combine');
    expect(MORE_NAV.map((item) => item.key)).toContain('combine');
  });

  it('一级 + 二级覆盖全部视图，且无重复、无交叉', () => {
    // ViewKey 全集：'merge' | 'dedupe' | 'excel' | 'combine' | 'library'
    const ALL_VIEWS = ['merge', 'dedupe', 'excel', 'combine', 'library'];
    const primary = PRIMARY_NAV.map((item) => item.key);
    const more = MORE_NAV.map((item) => item.key);
    const union = [...primary, ...more];

    // 并集 = 全集（任何一个 ViewKey 都有入口可达，漏一个那个页面就进不去）
    expect([...union].sort()).toEqual([...ALL_VIEWS].sort());
    // 无重复
    expect(new Set(union).size).toBe(union.length);
    // 交集为空（同一个视图不该同时出现在一级和二级）
    expect(primary.filter((key) => more.includes(key))).toEqual([]);
  });
});
