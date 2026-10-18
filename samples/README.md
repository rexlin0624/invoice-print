# 样本库

放**脱敏**发票样本，用于解析回归。每张样本配一份同名 `.expected.json`，测试会逐字段比对。

```
samples/
  private/   整个目录不入库（含 .expected.json）—— 真票的号码/税号/购销方都是个人数据
  public/    可以入库的合成样本（自己造的假票）；扩展名规则对两处都生效
```

期望文件格式（**下面是合成示例，值全是假的**）：字段名与 `Invoice` 一致，金额用**分**，
只写需要断言的字段，其余不写。

```json
{
  "kind": "vat-general",
  "businessTag": "成品油",
  "invoiceNo": "00000000000000000000",
  "issueDate": "2026-01-01",
  "buyerName": "某某贸易有限公司",
  "buyerTaxId": "913100000000000000",
  "sellerName": "某某石油销售有限公司",
  "sellerTaxId": "914400000000000000",
  "amount": 25303
}
```

## 怎么加样本

1. 把发票 PDF/OFD/XML 放进 `samples/private/`（或 `public/`）。
2. 用 `pnpm --filter @invoice-tool/core test` 跑一次，看实际值对不对。
3. 人工核对后写出 `.expected.json`。**不要拿解析器的输出当基线**，那是自证循环。

数量目标：技术方案要求 100+ 张，覆盖分省数电票、老版 PDF、各厂商 OFD、火车票、
机票行程单、扫描件。目前只有 2 张（成品油 / 通行费，同一开票方）。

## 诊断工具

版式不认识时，先把真实文字层 dump 出来看：

```bash
node packages/core/scripts/dump-pdf-text.mjs samples/private/xxx.pdf
node packages/core/scripts/dump-pdf-text.mjs samples/private/xxx.pdf --json
```
