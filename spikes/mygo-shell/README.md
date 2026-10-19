# MyGo 六项 spike（2026-10-19）

回答一个问题：**把外壳从 Tauri 换成 MyGo，前端那六件「靠浏览器能力」的事还跑不跑得动？**

结论：**六项全过，没有硬阻塞。但这次仍然不换** —— 理由是成熟度与迁移成本，不是技术。
决定与复查条件见文末。

- 被测框架：`github.com/egoist/mygo` **v0.5.5**（仓库 2026-09-26 建，一周五个版本）
- 被测前端：**真实的** `apps/web/dist`（`pnpm --filter @invoice-tool/web build`）
- 机器：macOS 27 / Apple Silicon / 8 GB，`go 1.27.2`

## 怎么跑

```sh
# 1. 出前端（这一步和网页版完全一样）
pnpm --filter @invoice-tool/web build

# 2. 准备素材（见下一节）
./spikes/mygo-shell/make-assets.sh

# 3. 跑。会开一个真窗口，Go 侧用 Page.Eval 驱动页面，结果打到 stdout
cd spikes/mygo-shell
go run . -dist ../../apps/web/dist -assets ./assets
```

跑完自动退出。全程约 15 秒（不含出前端）。

## 素材

`assets/` **不入库**：`invoice-a.pdf` 是真实发票（PII），只放在本地。

| 文件 | 用途 | 来源 |
| --- | --- | --- |
| `invoice-a.pdf` | pdfjs / 二维码 / `lp` 打印 | 自己放一张真实发票 |
| `smoke-a.xml`、`smoke-b.xml` | 拖放导入、去重 | `make-assets.sh` 生成（虚构公司） |
| `ocr-text.png` | 纯 OCR（**故意没有二维码**） | `make-assets.sh` 生成 |

缺哪个就跳过哪一步，不会中断整个 spike。

## 实测结果

| 项 | 结果 | 观测到的证据 |
| --- | --- | --- |
| pdfjs 的 module worker | ✅ | 两个 `type: module` 的 worker：`render.worker-*.js`、`pdf.worker-*.mjs`；预览槽位 1148 × 765 |
| zxing 的 wasm | ✅ | `zxing_reader-*.wasm` 200；号码标着「来自二维码」 |
| tesseract | ✅ | 模型 200，classic worker 起来；**没有二维码**的图上四个字段标着「来自OCR」 |
| IndexedDB | ✅ | 建库成功；配额 20.6 GB，已用 44 MB |
| 拖放 | ✅ | 合成 `drop` 导入 3 个文件；`File` 对象直接可用 |
| `lp` | ✅ | 105 KB 字节 sha256 与 JS 侧一致；`lp` 真的被调起 |

另外顺手量到的：

| 数字 | 值 |
| --- | --- |
| 原图查看（按需渲染） | 1400 × 933 px，251 ms |
| 一张图跑完 OCR | 2.5 s |
| 导入 3 个文件（含缩略图与二维码） | 5.3 s |
| JS → Go 传 105 KB | base64 后 140 KB（+33%），63 ms |
| 安全上下文 / `crypto.subtle` / `localStorage` | 都可用；排版设置真的落盘了 |

## 三个新发现（都不阻塞）

1. **脚本错误被 WebKit 掩码成 `Script error.`**，共 9 条，功能没有异常。
   排查要进 Web Inspector 看 —— 这是桌面壳相对浏览器的可观测性倒退。
2. **裸字节走 JSON 会变 base64**，体积 +33%。30 MB 的合成 PDF 会变成 40 MB 字符串。
   真要更快就走自定义协议，不走 `[]byte`。
3. **`window.print` 存在，但 WKWebView 里不可靠**。打印只能走 Go 调 `lp` ——
   和现在 Rust 侧的做法一样（`print.rs` 本来就是 `lp` / PowerShell）。

## 一个 spike 自身的坑（教训）

第一次跑出来「IndexedDB 不可用、`localStorage` 报 `SecurityError`」，差点写成结论。
实际是**量错了对象**：窗口还没导航时页面是 `about:blank`，`readyState` 已经是 `complete`，
`origin` 是 `null`。在这种页面上量存储只会得到假阴性。

所以等待条件不能只看 `readyState`，还要确认 `location.protocol === 'mygo:'`
且应用真的挂上了首屏（`#root` 有子节点）。

## 决定：现在不换

| 理由 | 说明 |
| --- | --- |
| 构建问题已经解决了 | 本机出包的痛由 `AGENTS.md` §1 的纪律和 CI 接管，换框架不是唯一解 |
| 换框架不解决签名 | 证书与公证仍要自己办，只是动作变顺 |
| 0.5.x 的风险由用户承担 | 框架 23 天大，一周五个版本；发票工具是长期装在用户机器上的 |
| 迁移是实打实的工作量 | 6 个 Go 能力模块、18 个 IPC 单测、新原点下的库迁移、CI 发布链重写 |

**复查条件**：MyGo 到 1.0，或半年后（2027-04）再看一次。到那时先补两件事：

1. 用 `mygo build` 出 `.app` 与 dmg（37 MB 前端要嵌进去），跑同一套六项；
2. 看一眼 Windows 侧的 WebView2 行为（本次只测了 macOS 的 WKWebView）。

## 本次没有验证的

- 打包形态：跑的是 `SetFrontend(os.DirFS(dist))`，不是 `mygo build` 嵌进二进制的 `.app`
- Windows / Linux 的 WebView 行为
- 代码签名、公证、自动更新
- 长时间运行的稳定性（本次只跑了十几秒）
