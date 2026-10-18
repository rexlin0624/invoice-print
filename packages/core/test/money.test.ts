import { describe, expect, it } from 'vitest';

import {
  capitalToCents,
  centsToCapital,
  centsToFixed,
  decimalToCents,
  findAmounts,
  formatCents,
} from '../src/model/money';

describe('decimalToCents', () => {
  it('按字符串切分，不经过浮点', () => {
    expect(decimalToCents('52.58')).toBe(5258);
    expect(decimalToCents('1,234.56')).toBe(123456);
    expect(decimalToCents('35.9')).toBe(3590);
    expect(decimalToCents('100')).toBe(10000);
    expect(decimalToCents('-12.34')).toBe(-1234);
  });

  it('拒绝非法输入', () => {
    expect(decimalToCents('abc')).toBeUndefined();
    expect(decimalToCents('1.234')).toBeUndefined();
    expect(decimalToCents('')).toBeUndefined();
  });

  it('避开 0.1+0.2 类误差', () => {
    // 真实踩坑：浮点直接乘会出尾巴（如 16.01 * 100 = 1601.0000000000002）
    const cents = decimalToCents('55.58');
    expect(cents).toBe(5558);
    expect(cents! % 1).toBe(0);
  });
});

describe('格式化', () => {
  it('centsToFixed / formatCents', () => {
    expect(centsToFixed(5258)).toBe('52.58');
    expect(centsToFixed(0)).toBe('0.00');
    expect(formatCents(5258)).toBe('¥52.58');
    expect(formatCents(123456789)).toBe('¥1,234,567.89');
  });
});

describe('findAmounts', () => {
  it('抽出带 ¥ 与千分位的金额', () => {
    expect(findAmounts('合计¥52.58¥3.00')).toEqual([5258, 300]);
    expect(findAmounts('（小写）¥1,234.56')).toEqual([123456]);
  });

  it('不会把税率和数量当金额', () => {
    expect(findAmounts('税率13%')).toEqual([]);
    expect(findAmounts('数量35')).toEqual([]);
  });
});

describe('capitalToCents（大写 → 分）', () => {
  it('真实票面', () => {
    expect(capitalToCents('伍拾伍圆伍角捌分')).toBe(5558);
    expect(capitalToCents('壹拾玖圆捌角柒分')).toBe(1987);
  });

  it('整、零、万、亿', () => {
    expect(capitalToCents('壹佰元整')).toBe(10000);
    expect(capitalToCents('零元整')).toBe(0);
    expect(capitalToCents('壹万贰仟叁佰肆拾伍圆陆角柒分')).toBe(1234567);
    expect(capitalToCents('壹亿圆整')).toBe(10000000000);
  });

  it('非法输入返回 undefined', () => {
    expect(capitalToCents('hello')).toBeUndefined();
    expect(capitalToCents('')).toBeUndefined();
  });
});

describe('centsToCapital（分 → 大写）', () => {
  it('与 capitalToCents 互为逆运算', () => {
    for (const cents of [0, 50, 100, 1987, 5558, 10000, 1234567, 10000000000]) {
      const words = centsToCapital(cents);
      expect(capitalToCents(words), `${cents} → ${words}`).toBe(cents);
    }
  });

  it('真实票面文案', () => {
    expect(centsToCapital(5558)).toBe('伍拾伍圆伍角捌分');
    expect(centsToCapital(1987)).toBe('壹拾玖圆捌角柒分');
    expect(centsToCapital(10000)).toBe('壹佰圆整');
  });
});
