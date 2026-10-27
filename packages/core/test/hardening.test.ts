/**
 * 硬化回归：陌生人给的字节不能撑爆内存、不能顶掉真票、不能把金额算成 Infinity。
 *
 * 这些用例刻意用**很小的预算**（几字节）而不是默认的 64/256 MB ——
 * 否则测试要么跑不动，要么只能「证明默认值很大」，证明不了限制真的生效。
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { findDuplicates } from '../src/dedupe/index';
import type { Invoice } from '../src/model/invoice';
import { MAX_INVOICE_PAGES, printablePages } from '../src/model/invoice';
import { capitalToCents, decimalToCents } from '../src/model/money';
import { ArchiveLimitError, expandArchive } from '../src/parse/index';
import { parseOfd } from '../src/parse/ofd';
import { parseInvoiceXml } from '../src/parse/xml';

async function zipOf(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    fileName: 'a.pdf',
    fileSize: 4,
    sha256: `hash-${Math.random().toString(36).slice(2)}`,
    kind: 'vat-general',
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
    ...over,
  };
}

describe('压缩包预算', () => {
  it('条目数超限时只展开前 N 条', async () => {
    const bytes = await zipOf({ 'a.pdf': PDF, 'b.pdf': PDF, 'c.pdf': PDF });
    const entries = await expandArchive(bytes, { maxEntries: 2 });
    expect(entries).toHaveLength(2);
  });

  it('单条解压后超限 → 拒绝整包，而不是先分配再判断', async () => {
    const bytes = await zipOf({ 'a.pdf': new Uint8Array(1024) });
    await expect(expandArchive(bytes, { maxEntryBytes: 16 })).rejects.toBeInstanceOf(
      ArchiveLimitError,
    );
  });

  it('总量超限 → 拒绝', async () => {
    const bytes = await zipOf({
      'a.pdf': new Uint8Array(64),
      'b.pdf': new Uint8Array(64),
    });
    await expect(
      expandArchive(bytes, { maxEntryBytes: 1024, maxTotalBytes: 100 }),
    ).rejects.toBeInstanceOf(ArchiveLimitError);
  });
});

describe('页数上限', () => {
  it('printablePages 不采信文件声明的页数', () => {
    const pages = printablePages({ pageCount: 2_147_483_647, skipPages: [] });
    expect(pages).toHaveLength(MAX_INVOICE_PAGES);
    expect(pages[0]).toBe(0);
    expect(pages.at(-1)).toBe(MAX_INVOICE_PAGES - 1);
  });

  it('skipPages 越界不会把页数组撑大', () => {
    expect(printablePages({ pageCount: 2, skipPages: [999_999] })).toEqual([0, 1]);
  });

  it('页数是 NaN / Infinity 时也不会算空', () => {
    // NaN 一路过 Math.max/Math.min 还是 NaN，循环一次都不跑 → 页数组会变空
    expect(printablePages({ pageCount: Number.NaN, skipPages: [] })).toEqual([0]);
    expect(printablePages({ pageCount: Number.POSITIVE_INFINITY, skipPages: [] })).toHaveLength(
      MAX_INVOICE_PAGES,
    );
    expect(printablePages({ pageCount: -5, skipPages: [] })).toEqual([0]);
  });
});

describe('金额溢出', () => {
  it('大写金额连写「壹亿」不会变成 Infinity', () => {
    expect(capitalToCents(`${'壹亿'.repeat(40)}圆整`)).toBeUndefined();
  });

  it('小数金额超上限 → undefined', () => {
    expect(decimalToCents(`${'9'.repeat(300)}.00`)).toBeUndefined();
    expect(decimalToCents('999999999999999999.00')).toBeUndefined();
  });
});

describe('XML 字段形状', () => {
  it('号码形态不对 → 不收该字段，也不会成为去重键', () => {
    const r = parseInvoiceXml(`<Invoice><InvoiceNumber>not-a-number</InvoiceNumber></Invoice>`);
    expect(r.fields.invoiceNo).toBeUndefined();
    expect(r.issues.map((issue) => issue.code)).toContain('invoice-no-shape');
  });

  it('名称过长 → 不收该字段，并提示', () => {
    const r = parseInvoiceXml(
      `<Invoice><SellerName>${'某'.repeat(5000)}</SellerName></Invoice>`,
    );
    expect(r.fields.sellerName).toBeUndefined();
    expect(r.issues.map((issue) => issue.code)).toContain('field-invalid');
  });

  it('税号形态不对 → 不收该字段', () => {
    const r = parseInvoiceXml(`<Invoice><SellerTaxId>abc</SellerTaxId></Invoice>`);
    expect(r.fields.sellerTaxId).toBeUndefined();
    expect(r.issues.map((issue) => issue.code)).toContain('tax-id-invalid');
  });

  it('首选键的值是坏的、后面候选键有正常值 → 用后面的', () => {
    const r = parseInvoiceXml(`<Invoice>
      <InvoiceNumber>---</InvoiceNumber>
      <Fphm>12345678</Fphm>
    </Invoice>`);
    expect(r.fields.invoiceNo).toBe('12345678');
    // 候选键的坏值不再把整张票的号码一起丢掉
  });

  it('首选键的税号是坏的 → 退回后面的候选键', () => {
    const r = parseInvoiceXml(`<Invoice>
      <SellerTaxId>abc</SellerTaxId>
      <Xsfsbh>91310000MA1FL1XX9C</Xsfsbh>
    </Invoice>`);
    expect(r.fields.sellerTaxId).toBe('91310000MA1FL1XX9C');
  });
});

describe('OFD 实体解码', () => {
  it('越界字符实体不会让整份 OFD 解析失败', async () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org">
  <ofd:Content>
    <ofd:TextObject>
      <ofd:TextCode X="10" Y="10" Size="3" DeltaX="3">发票号码&#999999999;</ofd:TextCode>
    </ofd:TextObject>
  </ofd:Content>
</ofd:Page>`;
    const document = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org">
  <ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 210 140</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData>
</ofd:Document>`;
    const bytes = await zipOf({
      'OFD.xml': '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org"/>',
      'Doc_0/Document.xml': document,
      'Doc_0/Pages/Page_0/Content.xml': content,
    });

    const result = await parseOfd(bytes);
    expect(result.pages.length).toBe(1);
    expect(result.pages[0]!.tokens.some((token) => token.text.includes('&#999999999;'))).toBe(true);
  });

  it('几十万个不配平的 TextCode 不会卡死（整页跳过）', async () => {
    const document = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org">
  <ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 210 140</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData>
</ofd:Document>`;
    // 只开不闭：开标签都有 `>`，但永远等不到闭标签。旧实现的正则会在每个开标签上
    // 一路扫到文件尾（O(n²)），这份让解析线程直接卡住。
    const open = '<ofd:TextCode X="1" Y="1" Size="3">';
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org"><ofd:Content><ofd:TextObject>${open.repeat(
      20_000,
    )}</ofd:TextObject></ofd:Content></ofd:Page>`;
    const bytes = await zipOf({
      'OFD.xml': '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org"/>',
      'Doc_0/Document.xml': document,
      'Doc_0/Pages/Page_0/Content.xml': content,
    });

    const started = Date.now();
    const result = await parseOfd(bytes);
    expect(result.pages).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('正文里连写 TextCode 不会让预检回扫成 O(n²)', async () => {
    const document = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org">
  <ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 210 140</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData>
</ofd:Document>`;
    // 没有 `<`，全是正文里的同名文字：用 `indexOf('TextCode')` 再 `lastIndexOf('<')`
    // 的写法，每个命中都会往回扫到文件头。
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org"><ofd:Content><ofd:TextObject>${'TextCode'.repeat(
      200_000,
    )}</ofd:TextObject></ofd:Content></ofd:Page>`;
    const bytes = await zipOf({
      'OFD.xml': '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org"/>',
      'Doc_0/Document.xml': document,
      'Doc_0/Pages/Page_0/Content.xml': content,
    });

    const started = Date.now();
    const result = await parseOfd(bytes);
    expect(Date.now() - started).toBeLessThan(5_000);
    // 标签是配平的（0 开 0 闭），但正文里没有 TextCode 文本对象 → 没有页
    expect(result.pages).toHaveLength(0);
  });
});

describe('同号票字段冲突', () => {
  it('号码相同但金额不同 → 只标记，不自动删任何一张', () => {
    const real = invoice({ invoiceNo: '12345678901234567890', total: 100_00 });
    const fake = invoice({ invoiceNo: '12345678901234567890', total: 999_00 });
    const result = findDuplicates([real, fake]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.level).toBe('invoice-no-conflict');
    expect(result.kept).toEqual([real.id, fake.id]);
    // 只把「建议跳过的那张」列进 flagged，但 kept 里两张都在 —— 不会真的少打
    expect(result.flagged).toEqual([fake.id]);
  });

  it('号码相同且金额一致 → 仍然按确定重复合并', () => {
    const pdf = invoice({ invoiceNo: '12345678901234567890', total: 100_00 });
    const ofd = invoice({
      invoiceNo: '12345678901234567890',
      total: 100_00,
      provenance: { invoiceNo: { source: 'ofd', confidence: 0.97 } },
    });
    const result = findDuplicates([pdf, ofd]);

    expect(result.groups[0]!.level).toBe('invoice-no');
    expect(result.kept).toHaveLength(1);
  });

  it('号码相同、销售方金额日期都相同，但购买方不同 → 只标记', () => {
    const real = invoice({
      invoiceNo: '12345678901234567890',
      sellerName: '某某科技',
      total: 100_00,
      buyerName: '真公司',
    });
    const fake = invoice({
      invoiceNo: '12345678901234567890',
      sellerName: '某某科技',
      total: 100_00,
      buyerName: '假公司',
    });
    const result = findDuplicates([real, fake]);

    expect(result.groups[0]!.level).toBe('invoice-no-conflict');
    // 两张都还在 kept 里，只是把 fake 标成「建议跳过」
    expect(result.kept).toHaveLength(2);
    expect(result.flagged).toEqual([fake.id]);
    expect(result.groups[0]!.reason).toContain('购买方');
  });

  it('号码相同、字段都对得上，但明细金额不同 → 只标记', () => {
    const real = invoice({
      invoiceNo: '12345678901234567890',
      total: 100_00,
      items: [{ name: '服务费', amount: 70_00 }, { name: '材料', amount: 30_00 }],
    });
    const fake = invoice({
      invoiceNo: '12345678901234567890',
      total: 100_00,
      items: [{ name: '服务费', amount: 10_00 }, { name: '材料', amount: 90_00 }],
    });
    const result = findDuplicates([real, fake]);

    expect(result.groups[0]!.level).toBe('invoice-no-conflict');
    expect(result.groups[0]!.reason).toContain('明细');
  });

  it('明细名称的排版差异（＊/空格）不算冲突', () => {
    const a = invoice({
      invoiceNo: '12345678901234567890',
      total: 100_00,
      items: [{ name: '＊餐饮服务', amount: 100_00 }],
    });
    const b = invoice({
      invoiceNo: '12345678901234567890',
      total: 100_00,
      items: [{ name: '餐饮 服务', amount: 100_00 }],
    });
    const result = findDuplicates([a, b]);

    expect(result.groups[0]!.level).toBe('invoice-no');
    expect(result.kept).toHaveLength(1);
  });

  it('销售方名称的空格差异不算冲突（同一张票的 XML 与文字层）', () => {
    const fromPdf = invoice({
      invoiceNo: '12345678901234567890',
      sellerName: '上海某某贸易有限公司',
      total: 100_00,
    });
    const fromXml = invoice({
      invoiceNo: '12345678901234567890',
      sellerName: '上海 某某 贸易有限公司',
      total: 100_00,
    });
    const result = findDuplicates([fromPdf, fromXml]);

    expect(result.groups[0]!.level).toBe('invoice-no');
    expect(result.kept).toHaveLength(1);
  });
});
