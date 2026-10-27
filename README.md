# 发票工具

[![Release](https://img.shields.io/github/v/release/rexlin0624/invoice-print?label=release)](https://github.com/rexlin0624/invoice-print/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Web-lightgrey)](#下载与安装)
[![Privacy](https://img.shields.io/badge/data-stays%20local-brightgreen)](#隐私与数据)

本地优先的**发票合并打印 / 查重 / 汇总**工具。把一堆发票拖进来，自动识别、去重、按 A4 排好版，
一张纸放 2 张或 4 张，带裁切线，点一下打印。

**文件不上传。** 解析、排版、打印 PDF 全部在本机生成，断网也能用，没有账号系统。

---

## 下载与安装

所有发布包都在 [Releases](https://github.com/rexlin0624/invoice-print/releases/latest)，文件名形如
`invoice-tool_<版本>_…`。

### Windows

1. 下载 `invoice-tool_<版本>_windows_x64-setup.exe`。
2. 运行安装包。**未签名**，SmartScreen 会拦一次：点「更多信息」→「仍要运行」。
3. 从开始菜单打开「发票工具」。

### macOS

1. 按芯片选择安装包：Apple 芯片用 `…_darwin_aarch64.dmg`，Intel 用 `…_darwin_x64.dmg`。
2. 打开 dmg，把「发票工具」拖进「应用程序」。
3. **首次打开要右键（或按住 Control 点击）→「打开」**。未签名、未公证，双击会被 Gatekeeper 拦下。

### 网页版（免安装）

1. 下载 `invoice-tool_<版本>_web.zip`，解压到一个目录。
2. 当静态站点托管即可，例如在本机跑：

   ```bash
   mkdir invoice-tool-web && unzip invoice-tool_<版本>_web.zip -d invoice-tool-web
   cd invoice-tool-web
   python3 -m http.server 8080
   # 打开 http://localhost:8080
   ```

   也可以放进 Nginx、Caddy 或任意静态托管服务。没有后端，也不需要数据库。

> 发布包里已带 OCR 中文模型（约 24 MB），下载后即可**离线**识别扫描件与图片发票。
> **Linux 不在支持范围**（只发布 Windows / macOS / 网页版）；Linux 上可以直接用网页版，或从源码运行。

---

## 使用方法

### 1. 导入

打开「合并打印」，把发票拖进窗口，或点「点击选择文件」。

- 支持 **PDF、OFD、XML、ZIP 压缩包**，可一次导入多个。
- 也能直接 **Ctrl / ⌘ + V 粘贴截图**。
- 文件只读，工具**不会修改或删除你的原始文件**。

导入后会自动识别票种、发票号码、开票日期、购销方与金额。重复的发票（文件相同，或发票代码 + 号码相同且字段一致）会自动跳过；号码相同但金额、销售方或明细对不上，以及 OCR 认出的号码撞号，都只提示、不自动跳过。

### 2. 核对与校正

- 列表中会显示金额、销售方、票种与缩略图。
- 点某一行的 **ⓘ** 可以查看每个字段的来源（XML / 二维码 / PDF 文字层 / OCR）与置信度，
  对着原图**校正字段或补录号码**；改过的字段会标成「手工填写」，并立刻参与查重与金额合计。
- 多页发票（如医疗票据带明细页）可以逐页勾选「打印哪些页」。

### 3. 排版与打印

- 默认按 A4 自动排版，每页 1 / 2 / 4 张，横竖自动选择，带裁切线。
- 打开**「更多设置」**可以调整纸张方向、每页张数、裁切线、黑白打印、裁白边等；
  调好的一套设置可以存成**排版预设**，下次一键切回。
- **打出来整体偏移**时，在「更多设置 → 打印校准」里调 ±20 mm，或打印一张方格测试页量出偏差。
- 点「打印」走系统打印对话框；点「下载 PDF」得到合成好的 A4 打印文件（矢量内嵌原票面，不降清晰度）。

### 4. 其他页面

| 页面         | 用途                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **查重**     | 文件级 / 代码 + 号码且字段一致时自动跳过；同号字段冲突、OCR 撞号与疑似重复只标记（不改你的选择） |
| **转 Excel** | 导出 `.xlsx`（列可选、带合计行、金额是数字、号码是文本）或 CSV                                   |
| **凑票**     | 给定目标金额，自动挑一组发票凑够（贪心 + 分支定界）                                              |
| **已报销库** | 打印后标记「已报销」，票据信息与原文件存进本机库，可搜索、可再打一份                             |

---

## 隐私与数据

- 解析、二维码解码、OCR、排版、生成 PDF **全部在本机完成**，不请求任何外部服务。
- 没有账号、没有遥测、没有云同步。
- 网页版的「已报销库」存在浏览器 IndexedDB 里；清除浏览器数据会清掉它，
  重要记录请用「转 Excel」导出，或改用桌面版。
- 桌面版每次库变动都会在数据目录留一份**清单备份**（帮助 → 桌面版 → 在文件管理器里显示），
  清浏览数据后可以从备份恢复记录与报销状态；原文件字节不在备份里。
  本地日志也放在那里。

---

## 常见问题

**Windows 提示「已保护你的电脑」？**
安装包未做代码签名。点「更多信息」→「仍要运行」即可。

**macOS 提示「无法打开，因为无法验证开发者」？**
右键（或 Control + 点击）应用图标 →「打开」→ 再点「打开」。之后就能正常双击。

**扫描件 / 图片发票能识别吗？**
能。发布包自带 OCR 模型，纯本地运行。但 OCR 准确率有限（置信度约 0.6），
号码与金额请对着原图核对一遍；能拿到 PDF 文字层或 XML 的发票会优先使用结构化数据。

**打出来位置偏了？**
纸张边缘、打印机进纸误差都会造成偏移。在「更多设置 → 打印校准」里微调即可，不需要改版面。

**支持 Linux / 手机吗？**
Linux 不在发布范围，建议直接用网页版。网页版做了响应式布局，但没有针对手机专门验证，
主目标仍是桌面浏览器。

**有云同步 / 多设备吗？**
没有，也不会加。桌面版会在数据目录里自动留一份库清单备份，换机器时复制它即可；
网页版请先用「转 Excel」导出记录。

---

## 从源码运行

需要 Node.js ≥ 20 与 pnpm（版本见 `packageManager` 字段，当前 `pnpm@12.3.4`）。

```bash
git clone https://github.com/rexlin0624/invoice-print.git
cd invoice-print

pnpm install
pnpm ocr:prepare   # 可选：拉取本地 OCR 资产（worker + wasm + 中文模型，约 24 MB）
pnpm dev           # http://localhost:5180
```

`pnpm ocr:prepare` 不做也能跑，只是扫描件 / 图片识别会提示模型缺失，其余功能不受影响。
资产来自 npm 包与 `naptha/tessdata`，校验 sha256 后写入 `apps/web/public/ocr/`，运行时不发外部请求。

其它常用命令：

```bash
pnpm test          # 内核回归（解析 / 去重 / 排版 / 导出）+ 外壳桥单测
pnpm typecheck     # 全部子包类型检查
pnpm build         # 产出 apps/web/dist（静态站点）
pnpm e2e           # 真实浏览器回归：无头 Chrome，12 项渲染检查
pnpm desktop:dev   # 桌面版（Tauri）：Vite + 原生窗口，需先满足 Rust 编译纪律
```

构建桌面安装包：

```bash
ALLOW_RUST_BUILD=1 pnpm desktop:build   # 本机默认禁止，需明示放行；CI 里自动允许
```

> ⚠️ 桌面端是 Tauri（Rust）。`desktop:dev` / `desktop:build` 会经过
> `apps/desktop/scripts/rust.mjs` 的内存闸门，本机默认拒绝执行；
> 规则与放行方式见 [`AGENTS.md`](AGENTS.md) §1。发布包默认由 CI 构建
> （`.github/workflows/release.yml`），推 `v*` 标签触发。

### 目录结构

```
packages/core   纯 TS 内核：解析 / 校验 / 查重 / 凑票 / 排版 / 导出（零 DOM、零 Node API）
apps/web        网页版（React + Vite），桌面端复用它的构建产物
apps/desktop    Tauri 桌面端：Rust 只保留 6 个能力模块，界面复用 apps/web
samples/        脱敏样本 + 期望 JSON（真票内容不入库）
docs/           架构决策与解析规则参考
```

---

## 技术栈

| 层       | 选型                                      |
| -------- | ----------------------------------------- |
| 内核     | TypeScript（纯函数，网页版 / 桌面版共用） |
| 界面     | React + Vite + 原生 CSS 设计令牌          |
| PDF 渲染 | pdf.js（渲染放在 Worker 里）              |
| 二维码   | zxing-wasm（本地 wasm）                   |
| OCR      | tesseract.js + 中文模型（本地 wasm）      |
| Excel    | ExcelJS（按需懒加载）                     |
| 桌面外壳 | Tauri 2（Rust）                           |

---

## 文档

- [`docs/解析规则参考.md`](docs/解析规则参考.md) — 票面版式、票种判定、字段规则、已知坑
- [`docs/打印与导出参考.md`](docs/打印与导出参考.md) — 排版几何、裁切线、栅格化、打印 PDF 合成
- [`docs/桌面端参考.md`](docs/桌面端参考.md) — 能力模块、IPC 契约、构建与验证状态
- [`AGENTS.md`](AGENTS.md) — 在本仓库工作的规则（含 Rust 编译纪律）

## 许可

本项目采用 MIT License。
