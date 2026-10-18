/**
 * 医疗票据明细页的识别与安全边界。
 *
 * ⚠️ 手上仍然没有两页的医疗真票文件，所以这里用**合成文本**验证判据与边界逻辑本身。
 * 但锚点写法不是猜的：按财政部式样附件 3、参考实现与财政电子票据查验平台的公开样本
 * 三方核对过（见 `docs/解析规则参考.md` §8）。真票到手后照 §9 复核。
 */

import { describe, expect, it } from 'vitest';

import type { PageText } from '../src/text/lines';
import { detectMedicalDetailPages, isMedicalDetailPage } from '../src/parse/medical';

function page(index: number, text: string): PageText {
  return { index, width: 595, height: 397, tokens: [], lines: [], text };
}

/** 明细页：同时出现「医疗收费明细」与「所属电子票据号码」 */
const DETAIL = '医疗收费明细 所属电子票据号码：32000000001234567890 项目名称 数量 单价 金额';
/** 首页：有票据代码、票据号码、交款人、金额 */
const COVER = '医疗门诊收费票据 票据代码：320602 票据号码：0001234567 交款人：张三 金额合计：¥320.00';

/** 公开样本的真实写法（江苏财政电子票据：医疗住院收费票据 + 医疗收费明细，第 1 页 共 2 页） */
const REAL_DETAIL =
  '医疗收费明细（电子） 所属电子票据代码：32060222 所属电子票据号码:0001409116 ' +
  '交款人：陆宸睿 开票日期：2022年 11月 3日 项目名称 数量/单位 金额（元） 备注';

describe('isMedicalDetailPage', () => {
  it('两个特征词齐全才算明细页', () => {
    expect(isMedicalDetailPage(DETAIL)).toBe(true);
    expect(isMedicalDetailPage('医疗收费明细 项目名称 金额')).toBe(false);
    expect(isMedicalDetailPage('所属电子票据号码：123')).toBe(false);
    expect(isMedicalDetailPage(COVER)).toBe(false);
  });

  it('真票写法：所属电子票据号码 + 标题（带（电子）后缀）', () => {
    expect(isMedicalDetailPage(REAL_DETAIL)).toBe(true);
  });

  it('带前缀的标题：门诊 / 住院 / 急诊', () => {
    for (const title of ['医疗门诊收费明细', '医疗住院收费明细', '医疗急诊收费明细']) {
      expect(isMedicalDetailPage(`${title} 所属电子票据号码：0001409116`)).toBe(true);
    }
  });

  it('「编号」是同一字段的历史写法，一并接受', () => {
    expect(isMedicalDetailPage('医疗收费明细 所属电子票据编号：123')).toBe(true);
  });

  it('只有「所属」前缀、没有标题时不算（防商品名误撞）', () => {
    expect(isMedicalDetailPage('所属电子票据号码：123 项目名称 医疗收费')).toBe(false);
  });

  it('空白与全角空格不影响判定（先 squash）', () => {
    expect(isMedicalDetailPage('医疗收费明细　　所属电子票据号码')).toBe(true);
  });
});

describe('detectMedicalDetailPages 的安全边界', () => {
  it('两页票据：剔掉明细页', () => {
    expect(detectMedicalDetailPages([page(0, COVER), page(1, DETAIL)])).toEqual([1]);
  });

  it('真票式两页：首页 + 明细页', () => {
    expect(detectMedicalDetailPages([page(0, COVER), page(1, REAL_DETAIL)])).toEqual([1]);
  });

  it('三页票据：只剔掉命中特征的那一页', () => {
    expect(detectMedicalDetailPages([page(0, COVER), page(1, DETAIL), page(2, COVER + ' 第二页')])).toEqual([
      1,
    ]);
  });

  it('只有一页时永不剔除（可能是版式把特征词印在首页）', () => {
    expect(detectMedicalDetailPages([page(0, DETAIL)])).toEqual([]);
  });

  it('全部页面都命中特征时也不剔除 —— 判据失效，宁可不剔', () => {
    expect(detectMedicalDetailPages([page(0, DETAIL), page(1, DETAIL)])).toEqual([]);
  });

  it('没有明细页时返回空数组', () => {
    expect(detectMedicalDetailPages([page(0, COVER), page(1, COVER)])).toEqual([]);
    expect(detectMedicalDetailPages([])).toEqual([]);
  });
});
