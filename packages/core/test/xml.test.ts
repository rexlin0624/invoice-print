import { describe, expect, it } from 'vitest';

import { normalizeKey, parseInvoiceXml } from '../src/parse/xml';

describe('normalizeKey', () => {
  it('抹平命名空间、大小写与分隔符', () => {
    expect(normalizeKey('#text')).toBe('text');
    expect(normalizeKey('InvoiceNumber')).toBe('invoicenumber');
    expect(normalizeKey('invoice_number')).toBe('invoicenumber');
    expect(normalizeKey('@_Id')).toBe('id');
    expect(normalizeKey('ns0:InvoiceNo')).toBe('invoiceno');
    expect(normalizeKey('发票号码')).toBe('发票号码');
  });
});

const EINVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://www.chinatax.gov.cn/einv">
  <Main>
    <InvoiceNumber>12345678901234567890</InvoiceNumber>
    <IssueDate>2026-06-19</IssueDate>
    <SellerName>某某测试乙有限公司</SellerName>
    <SellerTaxId>9144000000000011MN</SellerTaxId>
    <BuyerName>某某测试甲有限公司</BuyerName>
    <BuyerTaxId>9131000000000011MK</BuyerTaxId>
    <AmountWithoutTax>52.58</AmountWithoutTax>
    <TotalTax>3.00</TotalTax>
    <TotalAmountWithTax>55.58</TotalAmountWithTax>
    <TotalAmountInWords>伍拾伍圆伍角捌分</TotalAmountInWords>
  </Main>
</Invoice>`;

describe('parseInvoiceXml — 数电票标准结构', () => {
  const r = parseInvoiceXml(EINVOICE);

  it('号码 / 日期 / 购销方', () => {
    expect(r.fields.invoiceNo).toBe('12345678901234567890');
    expect(r.fields.issueDate).toBe('2026-06-19');
    expect(r.fields.sellerName).toBe('某某测试乙有限公司');
    expect(r.fields.sellerTaxId).toBe('9144000000000011MN');
    expect(r.fields.buyerName).toBe('某某测试甲有限公司');
    expect(r.fields.buyerTaxId).toBe('9131000000000011MK');
  });

  it('金额：不含税 / 税额 / 价税合计（分）', () => {
    expect(r.fields.amount).toBe(5258);
    expect(r.fields.tax).toBe(300);
    expect(r.fields.total).toBe(5558);
    expect(r.fields.totalInWords).toBe('伍拾伍圆伍角捌分');
  });

  it('记录来源锚点', () => {
    expect(r.anchors.invoiceNo).toBe('<invoicenumber>');
    expect(r.confidence.invoiceNo).toBe(0.99);
  });

  it('无解析问题', () => {
    expect(r.issues).toEqual([]);
  });
});

describe('parseInvoiceXml — 方言容错', () => {
  it('下划线风格的元素名', () => {
    const r = parseInvoiceXml(
      `<e><invoice_no>0012345678</invoice_no><issue_date>2026/06/19</issue_date><seller_name>甲公司</seller_name></e>`,
    );
    expect(r.fields.invoiceNo).toBe('0012345678');
    expect(r.fields.issueDate).toBe('2026-06-19');
    expect(r.fields.sellerName).toBe('甲公司');
  });

  it('中文标签', () => {
    const r = parseInvoiceXml(
      `<票><发票号码>10987654321098765432</发票号码><开票日期>2026年06月22日</开票日期><销售方名称>乙公司</销售方名称><价税合计>19.87</价税合计></票>`,
    );
    expect(r.fields.invoiceNo).toBe('10987654321098765432');
    expect(r.fields.issueDate).toBe('2026-06-22');
    expect(r.fields.sellerName).toBe('乙公司');
    expect(r.fields.total).toBe(1987);
  });

  it('值放在属性里也能取到', () => {
    const r = parseInvoiceXml(`<Invoice><Main InvoiceNumber="12345678901234567890" /></Invoice>`);
    expect(r.fields.invoiceNo).toBe('12345678901234567890');
  });

  it('保留前导零（不能被当成数字）', () => {
    const r = parseInvoiceXml(`<e><InvoiceNumber>00000000000000001234</InvoiceNumber></e>`);
    expect(r.fields.invoiceNo).toBe('00000000000000001234');
  });

  it('只有 TotalAmount（= 价税合计）时不会误当不含税金额', () => {
    const r = parseInvoiceXml(`<e><TotalAmount>55.58</TotalAmount></e>`);
    expect(r.fields.amount).toBeUndefined();
  });

  it('坏 XML 不抛异常', () => {
    const r = parseInvoiceXml('<e><a>1</b></e>');
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('大写金额能换算成 total', () => {
    const r = parseInvoiceXml(`<e><TotalAmountInWords>壹拾玖圆捌角柒分</TotalAmountInWords></e>`);
    expect(r.fields.total).toBe(1987);
  });

  it('残缺日期给出 warn 而不是崩溃', () => {
    const r = parseInvoiceXml(`<e><IssueDate>不是日期</IssueDate></e>`);
    expect(r.fields.issueDate).toBeUndefined();
    expect(r.issues.some((i) => i.code === 'date-invalid')).toBe(true);
  });
});
