/**
 * 二维码解析与交叉校验。
 *
 * 两条 `QUAN_DIAN` 是从真实数电票上实解出来的原文（见 samples/private/*.expected.json），
 * 不是编的 —— 字段位置就是照它们定的。
 *
 * 解码本身（图像 → 字符串）需要 WASM + canvas，在浏览器里做，
 * 由 `apps/web/src/lib/qr.ts` 负责；这里只测「字符串 → 字段」这一半。
 */

import { describe, expect, it } from 'vitest';

import type { InvoiceKind } from '../src/model/invoice';
import {
  crossCheckQr,
  extractFromQr,
  kindFromQr,
  parseQrPayload,
} from '../src/parse/qr';

/** 成品油合成样本 A 票面左上角二维码的实解原文 */
const ZHONGSHIHUA = '01,32,,12345678901234567890,55.58,20260619,,300A';
/** 通行费合成样本 B 的实解原文 */
const LULU = '01,32,,10987654321098765432,19.87,20260622,,6283';

describe('parseQrPayload', () => {
  it('解出真票的号码 / 价税合计 / 开票日期', () => {
    const p = parseQrPayload(ZHONGSHIHUA);
    expect(p).toBeDefined();
    expect(p!.invoiceNo).toBe('12345678901234567890');
    expect(p!.issueDate).toBe('2026-06-19');
    expect(p!.total).toBe(5558);
    expect(p!.kindCode).toBe('32');
    // 数电票没有发票代码，也不该凭空造一个空串
    expect(p!.invoiceCode).toBeUndefined();
    expect(p!.checkCode).toBeUndefined();
    expect(p!.tail).toBe('300A');
  });

  it('金额走整数「分」，不经过浮点', () => {
    // 真实踩坑：16.01 * 100 = 1601.0000000000002（不是 1601），直接乘再取整会出错
    expect(parseQrPayload(LULU)!.total).toBe(1987);
  });

  it('尾码不参与字段，只留在 anchors 里做诊断', () => {
    const { fields, anchors } = extractFromQr(parseQrPayload(ZHONGSHIHUA)!);
    expect(fields).not.toHaveProperty('tail');
    expect(anchors.qrTail).toBe('300A');
    expect(anchors.qr).toBe(ZHONGSHIHUA);
  });

  it('不接受非发票二维码（官网 / 小程序 / 验真链接）', () => {
    expect(parseQrPayload('https://inv-veri.chinatax.gov.cn/')).toBeUndefined();
    expect(parseQrPayload('01,32,,12345678901234567890')).toBeUndefined(); // 缺日期
    expect(parseQrPayload('02,32,,12345678901234567890,55.58,20260619')).toBeUndefined(); // 头不对
    expect(parseQrPayload('')).toBeUndefined();
  });

  it('号码形状不对就整条丢弃（宁可没有，也不要脏数据）', () => {
    expect(parseQrPayload('01,32,,12345,55.58,20260619,')).toBeUndefined();
    expect(parseQrPayload('01,32,,1234567890123456789X,55.58,20260619,')).toBeUndefined();
  });

  it('日期不合法就整条丢弃', () => {
    expect(parseQrPayload('01,32,,12345678901234567890,55.58,20261340,')).toBeUndefined();
    expect(parseQrPayload('01,32,,12345678901234567890,55.58,202606,')).toBeUndefined();
  });

  it('兼容老税控票（8 位号码 + 20 位校验码）', () => {
    const p = parseQrPayload('01,04,011001900111,18741913,1000.00,20190422,11112222333344445555,');
    expect(p).toBeDefined();
    expect(p!.invoiceNo).toBe('18741913');
    expect(p!.invoiceCode).toBe('011001900111');
    expect(p!.checkCode).toBe('11112222333344445555');
    expect(p!.total).toBe(100000);
  });
});

describe('kindFromQr', () => {
  it('32 → 普通发票（真票验证过）', () => {
    expect(kindFromQr(parseQrPayload(ZHONGSHIHUA)!)).toBe('vat-general');
  });

  it('没验证过的代码不猜', () => {
    expect(kindFromQr(parseQrPayload('01,99,,12345678901234567890,1.00,20260619,')!)).toBeUndefined();
  });
});

describe('crossCheckQr', () => {
  const payload = parseQrPayload(ZHONGSHIHUA)!;

  it('完全一致 → 不吵', () => {
    const issues = crossCheckQr(payload, {
      invoiceNo: '12345678901234567890',
      total: 5558,
      issueDate: '2026-06-19',
      kind: 'vat-general',
    });
    expect(issues).toEqual([]);
  });

  it('号码 / 金额 / 日期对不上 → 各报一发警告，且带字段名', () => {
    const issues = crossCheckQr(payload, {
      invoiceNo: '11119999888877776666',
      total: 5559,
      issueDate: '2026-06-20',
      kind: 'vat-general',
    });
    expect(issues.map((i) => i.field).sort()).toEqual(['invoiceNo', 'issueDate', 'total']);
    for (const i of issues) {
      expect(i.code).toBe('qr-mismatch');
      expect(i.level).toBe('warn');
    }
  });

  it('文字层没读到的字段不报警，也不趁机改值', () => {
    // invoiceNo / total / issueDate 全缺 → 一条都不该报
    expect(crossCheckQr(payload, { kind: 'unknown' })).toEqual([]);
  });

  it('通行费票（toll）与 32（普票）不矛盾 —— 别误报', () => {
    // 通行费本身就是普票的一种，只是业务上更具体；拿家族比，不拿具体票种比
    expect(crossCheckQr(payload, { kind: 'toll' })).toEqual([]);
  });

  it('专票却报普票代码 → 报矛盾', () => {
    const issues = crossCheckQr(payload, { kind: 'vat-special' });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe('kind');
  });

  it('增值税家族之外的票种不参与比较（避免按未验证的表报警）', () => {
    const kinds: InvoiceKind[] = ['train', 'air', 'medical', 'nontax', 'taxi', 'ride', 'unknown'];
    for (const kind of kinds) {
      expect(crossCheckQr(payload, { kind }), `票种 ${kind} 不该报警`).toEqual([]);
    }
  });
});
