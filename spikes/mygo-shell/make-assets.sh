#!/bin/sh
# 生成 spike 用的合成素材。真实发票（invoice-a.pdf）自己放，脚本不碰。
set -eu

cd "$(dirname "$0")"
mkdir -p assets

cat > assets/smoke-a.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <InvoiceNumber>24312000000012345678</InvoiceNumber>
  <IssueDate>2026-10-01</IssueDate>
  <SellerName>杭州示例科技有限公司</SellerName>
  <SellerTaxId>91330100MA2XXKX11A</SellerTaxId>
  <BuyerName>上海示例贸易有限公司</BuyerName>
  <BuyerTaxId>91310115MA1XXKX22B</BuyerTaxId>
  <AmountWithoutTax>1000.00</AmountWithoutTax>
  <TotalTax>130.00</TotalTax>
  <TotalAmountWithTax>1130.00</TotalAmountWithTax>
</Invoice>
XML

cat > assets/smoke-b.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <IssueDate>2026-10-02</IssueDate>
  <SellerName>苏州示例服务有限公司</SellerName>
  <SellerTaxId>91320500MA2XXKX33C</SellerTaxId>
  <BuyerName>上海示例贸易有限公司</BuyerName>
  <BuyerTaxId>91310115MA1XXKX22B</BuyerTaxId>
  <AmountWithoutTax>500.00</AmountWithoutTax>
  <TotalTax>0.00</TotalTax>
  <TotalAmountWithTax>500.00</TotalAmountWithTax>
</Invoice>
XML

# OCR 素材：只有中文文字，**故意没有二维码** —— 拿到的字段只可能来自 OCR。
cat > assets/ocr-text.html <<'HTML'
<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#fff;font:600 46px -apple-system,'PingFang SC',sans-serif;color:#111">
<div style="padding:60px 70px;line-height:1.9">
<div style="font-size:56px">电子发票（普通发票）</div>
<div>发票号码：26447000009988776655</div>
<div>开票日期：2026年10月19日</div>
<div>销售方名称：杭州测试科技有限公司</div>
<div>价税合计（小写）：¥1,130.00</div>
</div></body>
HTML

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ]; then
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1400,700 \
    --screenshot="$PWD/assets/ocr-text.png" \
    "file://$PWD/assets/ocr-text.html" >/dev/null 2>&1
  echo "已生成 assets/ocr-text.png"
else
  echo "跳过 ocr-text.png：没找到 Chrome（其他浏览器截图也行，1400×700 即可）"
fi

if [ ! -f assets/invoice-a.pdf ]; then
  echo "还缺 assets/invoice-a.pdf：放一张真实发票，涉及 pdfjs / 二维码 / lp 三步"
fi
