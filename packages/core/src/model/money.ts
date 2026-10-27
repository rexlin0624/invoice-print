/**
 * 金额工具。
 *
 * 约定：金额一律用**整数「分」**表示。浮点数只允许在解析的最后一步出现，
 * 且必须走 `decimalToCents` 这种按字符串切分的方式，绝不 `parseFloat * 100`。
 */

/** 金额，单位：分 */
export type Cents = number;

/**
 * 金额上限（分）：1000 亿元。
 *
 * 这个数字远大于任何真实发票，作用只是**挡住溢出与荒谬值**：
 * 中文大写金额可以写成「壹亿壹亿…」，多次乘方会变成 `Infinity`，
 * 一旦进入批次合计，整页金额都变成 `NaN`/`Infinity`，且没有任何提示。
 */
export const MAX_AMOUNT_CENTS = 1e13;

/** 数字（含千分位、可带负号）→ 分。失败返回 undefined。 */
export function decimalToCents(input: string): Cents | undefined {
  const s = input.replace(/[,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) return undefined;
  const cents = sign * (whole * 100 + frac);
  if (!Number.isFinite(cents) || Math.abs(cents) > MAX_AMOUNT_CENTS) return undefined;
  return cents;
}

/** 分 → "1234.56"（无千分位） */
export function centsToFixed(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${neg ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/** 分 → "¥1,234.56" */
export function formatCents(cents: Cents, symbol = '¥'): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${symbol}${whole}.${frac}`;
}

/** 文本里所有金额（分）。用于「取这一行/这一段里的钱」。 */
export function findAmounts(text: string): Cents[] {
  const out: Cents[] = [];
  // 允许 ¥￥ 前缀与千分位；至少要有小数点，避免把增值税率 "13%"、数量 "35.9" 以外的整数日期误当金额
  const re = /[¥￥]?\s?(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cents = decimalToCents(m[1] ?? '');
    if (cents !== undefined) out.push(cents);
  }
  return out;
}

/** 是否包含「¥/￥」前缀（金额可信度更高的信号） */
export function hasCurrencySymbol(text: string): boolean {
  return /[¥￥]/.test(text);
}

// ---------------------------------------------------------------------------
// 中文大写金额
// ---------------------------------------------------------------------------

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
};
const CN_SMALL_UNIT: Record<string, number> = { 拾: 10, 佰: 100, 仟: 1000 };
const CN_YUAN = '圆元';
const CN_ZEROISH = '零〇整正';

/** 中文整数（如「伍拾伍」「壹万贰仟」）→ number。失败返回 undefined。 */
function chineseIntegerToNumber(text: string): number | undefined {
  let total = 0;
  let section = 0;
  let pending = 0;
  let sawAny = false;

  for (const ch of text) {
    if (ch in CN_DIGIT) {
      pending = CN_DIGIT[ch]!;
      sawAny = true;
    } else if (ch in CN_SMALL_UNIT) {
      const unit = CN_SMALL_UNIT[ch]!;
      section += (pending || 1) * unit;
      pending = 0;
      sawAny = true;
    } else if (ch === '万') {
      section = (section + pending) * 10_000;
      total += section;
      section = 0;
      pending = 0;
      sawAny = true;
    } else if (ch === '亿') {
      total = (total + section + pending) * 100_000_000;
      section = 0;
      pending = 0;
      sawAny = true;
    } else if (CN_ZEROISH.includes(ch)) {
      // 零只作占位，不影响数值
      sawAny = true;
    } else {
      return undefined; // 出现非法字符
    }
  }
  if (!sawAny) return undefined;
  const value = total + section + pending;
  // 「壹亿」连写 40 次会乘到 Infinity；这里直接判失败，别让它流进批次合计
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 中文大写金额 → 分。例：
 *   伍拾伍圆伍角捌分 → 5558
 *   壹佰元整             → 10000
 *   零元整               → 0
 */
export function capitalToCents(input: string): Cents | undefined {
  const s = input.replace(/[\s,，]/g, '');
  if (s === '') return undefined;

  const yuanIdx = s.search(new RegExp(`[${CN_YUAN}]`));
  if (yuanIdx === -1) return undefined;

  const intText = s.slice(0, yuanIdx);
  const rest = s.slice(yuanIdx + 1);

  let cents = 0;
  if (intText !== '') {
    const n = chineseIntegerToNumber(intText);
    if (n === undefined) return undefined;
    cents += n * 100;
  }

  // 「X角Y分」——数字可以省略（如「伍圆整」「伍圆零五分」）
  const jm = /([零壹贰叁肆伍陆柒捌玖])?角/.exec(rest);
  const fm = /([零壹贰叁肆伍陆柒捌玖])?分/.exec(rest);
  if (jm) cents += (jm[1] ? CN_DIGIT[jm[1]]! : 0) * 10;
  if (fm) cents += fm[1] ? CN_DIGIT[fm[1]]! : 0;

  if (!Number.isFinite(cents) || cents > MAX_AMOUNT_CENTS) return undefined;
  return cents;
}

/** 分 → 中文大写金额（用于生成票面信息卡）。 */
export function centsToCapital(cents: Cents): string {
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const jiao = Math.floor((abs % 100) / 10);
  const fen = abs % 10;

  const digits = '零壹贰叁肆伍陆柒捌玖';
  const units = ['', '拾', '佰', '仟'];
  const sections = ['', '万', '亿', '万亿'];

  const wholeToCn = (n: number): string => {
    if (n === 0) return '零';
    const groups: number[] = [];
    let rest = n;
    while (rest > 0) {
      groups.push(rest % 10_000);
      rest = Math.floor(rest / 10_000);
    }
    let out = '';
    for (let g = groups.length - 1; g >= 0; g--) {
      const v = groups[g]!;
      if (v === 0) {
        if (out !== '' && !out.endsWith('零')) out += '零';
        continue;
      }
      let part = '';
      let zero = false;
      const ds = String(v).split('').map(Number);
      for (let i = 0; i < ds.length; i++) {
        const d = ds[i]!;
        const unit = units[ds.length - 1 - i]!;
        if (d === 0) {
          zero = true;
        } else {
          if (zero && part !== '') part += '零';
          zero = false;
          part += digits[d]! + unit;
        }
      }
      out += part + (sections[g] ?? '');
    }
    return out;
  };

  let out = wholeToCn(whole) + '圆';
  if (jiao === 0 && fen === 0) return out + '整';
  if (jiao > 0) out += digits[jiao]! + '角';
  else if (fen > 0) out += '零';
  if (fen > 0) out += digits[fen]! + '分';
  return out;
}
