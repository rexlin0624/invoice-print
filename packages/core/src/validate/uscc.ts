/**
 * 统一社会信用代码（GB 32100-2015）校验位。
 *
 * 注意：老票的「纳税人识别号」是 15/17/18/20 位数字，**不是**统一社会信用代码，
 * 不能拿这套算法去判它错。所以这里只对「18 位且各字符都在 31 字符集内」的号码校验，
 * 其余情况返回 'unknown'。
 */

/** 31 个可用字符，刻意去掉了容易混淆的 I O S V Z */
const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

export type TaxIdCheck = 'valid' | 'invalid' | 'unknown';

export function isValidUscc(code: string): boolean {
  const s = code.trim().toUpperCase();
  if (s.length !== 18) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = USCC_CHARSET.indexOf(s[i]!);
    if (v === -1) return false;
    sum += v * USCC_WEIGHTS[i]!;
  }
  const remainder = sum % 31;
  const checkIndex = remainder === 0 ? 0 : 31 - remainder;
  return s[17] === USCC_CHARSET[checkIndex];
}

/** 计算正确的校验位（用于测试与生成） */
export function usccCheckChar(code17: string): string | undefined {
  const s = code17.trim().toUpperCase();
  if (s.length !== 17) return undefined;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = USCC_CHARSET.indexOf(s[i]!);
    if (v === -1) return undefined;
    sum += v * USCC_WEIGHTS[i]!;
  }
  const remainder = sum % 31;
  return USCC_CHARSET[remainder === 0 ? 0 : 31 - remainder];
}

export function checkTaxId(raw: string | undefined): TaxIdCheck {
  if (raw === undefined) return 'unknown';
  const s = raw.trim().toUpperCase();
  if (s === '') return 'unknown';

  // 纯数字的长号（15/17/18/20）是老纳税识别号，不适用 USCC 校验
  if (/^\d{15}$|^\d{17}$|^\d{18}$|^\d{20}$/.test(s)) {
    // 18 位纯数字：两种体系都可能，无法判定
    return 'unknown';
  }
  if (s.length === 18 && [...s].every((c) => USCC_CHARSET.includes(c))) {
    return isValidUscc(s) ? 'valid' : 'invalid';
  }
  return 'unknown';
}
