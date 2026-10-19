# AGENTS.md — 在本仓库工作的规则

> 本文件同时约束人与 AI 编程工具。违反下面「Rust 编译纪律」的代价是**整机重启**，不是玩笑。

## 0. 项目性质

「发票工具」：本地优先的发票合并打印 / 查重 / 汇总工具。
**一套内核，两个外壳** —— 业务逻辑全部在 `packages/core`（TypeScript 纯函数），
`apps/web` 与 `apps/desktop` 只做外壳。

## 1. Rust 编译纪律（**最重要**）

本机是 **8 GB / Apple Silicon / 16 KB page**，内存本来就紧。这条纪律的依据**不是**
「已经烧过一次」：`JetsamEvent-2026-10-16-091429.ips` 里 free 只剩 233 MB 不假，
但吃东西的**全是系统进程**（WindowServer / Setup Assistant / mds / MTLCompilerService），
而且它发生在**开机两分钟后** —— 那次并没有 cargo 在跑
（`shutdown_stall` 是更早 08:36 的另一份报告）。

依据是**代价不对称**：`cargo build` 会触发完整 codegen 与**单进程链接**，
`tauri build` 还要多跑一遍前端构建与打包；而它换来的只是一个 **CI 也能出的包**。
**一次误判的代价是整机重启，会带走你正在做的事。**

`-j 1`（或 `CARGO_BUILD_JOBS=1`）确实管用 —— 2026-10-18 实测：

| 命令（都是 `-j 1`） | 耗时 | 进程树峰值 RSS |
| --- | --- | --- |
| `cargo check --all-targets`（`-j 2`，缓存命中） | 0.28 s | 105–342 MB |
| `cargo build`（debug，~120 crate + 链接） | 1 m 11 s | 744 MB |
| `tauri build`（release，全树冷编 + 链接 + 打包） | 4 m 07 s | 1178 MB |

所以本机**跑得动**完整 release 打包（同日产出 `发票工具.app` 31 MiB / dmg 26.3 MiB）。
`-j 1` 管不住的是**什么时候涨** —— 突发可能发生在你没看着屏幕的时候。
重点不是「禁止链接」，而是**别在没人看着、又没量过内存的时候链接**。
默认因此仍然是禁止，「明示放行」才是那条路：

- ✅ 允许：`cargo check -j 2`（只产 metadata，轻）；本机入口是 `pnpm desktop:check`
  （= `cargo check --all-targets -j 2`，连 `#[cfg(test)]` 里的代码一起检查）
- ❌ 默认禁止：`cargo build`、`cargo build --release`、`cargo test`、`cargo run`、`tauri build`
  —— 一次至少几百 MB、动辄几分钟，且峰值可能出现在你走开之后。
  真要跑：`ALLOW_RUST_BUILD=1 CARGO_BUILD_JOBS=1 …`，先看自检报告再决定；
  发布包仍然**优先交给 CI**。
- 🛡️ `apps/desktop/scripts/rust.mjs` 是这条纪律的执行者：本机跑 `pnpm desktop:dev` /
  `desktop:build` / `desktop:test:rust` 会被**直接拒绝**并说明原因；
  要故意闯祸得先设 `ALLOW_RUST_BUILD=1`（CI 里 `CI=true` 自动放行）。
  它顺手解决了另一个坑：这台机器上 `~/.cargo/bin` 不在 PATH 里 —— 而且找到之后必须把这个
  目录**塞进子进程的 PATH**：`tauri` 是 node 程序，它按名字去 spawn `cargo metadata`，
  只给绝对路径不够（第一次打正式包就是栽在这儿的）。
- 🧮 **起飞前自检**（同在那个脚本里）：会链接的命令（`cargo build/test/run`、任何 `tauri …`）
  在**启动 cargo 之前**先量一次可用内存，不到 `RUST_MIN_FREE_MB`（默认 3000 MB）就拒绝，
  并列出「现在最吃内存的应用 + 对应的 `osascript -e 'quit app …'`」。
  **内存紧张时退应用，不要退终端** —— 终端自己就是本会话，退了等于把正在做的事一起退掉；
  而且大头通常不是它（实测 Chrome 788 MB / 微信 433 MB，终端只有 57 MB）。
  `cargo check` 不链接（实测峰值 105–342 MB），低于门槛只提醒、不拦。
  真要硬跑：`RUST_SKIP_PREFLIGHT=1`。
- 🐕 **内存看门狗**（同在那个脚本里）：命令一跑起来就持续采样
  （前 5 秒每 100 ms，之后每 2 秒），任一越界就 **SIGKILL 整棵进程树**：
  进程树 RSS > `RUST_MAX_MEMORY_MB`（默认 2500 MB），
  或系统可用内存占比 < `RUST_MIN_FREE_RATIO`（默认 0.12）。
  **宁可这次检查失败，也不要机器重启** —— 检查可以再跑，重启会带走你正在做的事。
  正常 `cargo check` 实测峰值 105–342 MB，离上限很远；上限是给「跑飞了」准备的。
  看门狗自己会打印峰值与采样次数，跑完扫一眼就知道有没有逼近上限。
- ⚠️ 本机出 release 包**可行但非常规**（实测 4 m 07 s / 1178 MB）：同一个包 CI 也能出，
  而 CI 不占你的内存。**发布包默认在 GitHub Actions 里构建**（`.github/workflows/release.yml`）；
  要在本机出，就照上面那样明示放行。出哪些平台的包见 §7。
- 🔁 **换壳不是解法。** 2026-10-19 把真实前端装进 MyGo v0.5.5 实测过：六项 webview 能力
  （pdfjs module worker / zxing wasm / tesseract / IndexedDB / 拖放 / `lp`）全过，
  但结论仍是**不换** —— 构建的痛由 CI 与本节的纪律解决；换框架既不解决签名，
  又要重写 6 个能力模块与 IPC 契约。记录见 `spikes/mygo-shell/` 与
  `docs/桌面端参考.md` §10。复查条件：MyGo 到 1.0 或 2027-04。
- ⛔ **同一时间只允许存在一个 cargo 进程。** 有 cargo 在跑就等它结束，不要并行开第二个。
- ⛔ 不要让 rust-analyzer 自动 `cargo build`（见 `.vscode/settings.json`，已改为 `check`）。
- 需要降优先级时用 `taskpolicy -c background cargo check`（**是 `-c background`，不是 `-b`**）。
- 不要 `cargo clean`；`target/` 保留可复用。

**前端开发不需要任何 Rust**：`pnpm dev` 走 Vite 热更新即可。
只有改 `apps/desktop/src-tauri` 时才碰 cargo，且只跑 `cargo check`。

## 2. 目录职责

```
packages/core        纯 TS 内核：解析 / 校验 / 去重 / 排版 / 导出。零 DOM、零 Node API、零 Rust。
apps/web             网页版（React + Vite）。M1 目标。
apps/desktop         Tauri 桌面端（M4）。Rust 只保留 6 个能力模块：app / dialog / files / print / shell / store。
                     界面复用 apps/web 的构建产物，**桌面端没有自己的界面代码**。
                     契约与验证状态见 `docs/桌面端参考.md`。
samples/             脱敏样本 + 期望 JSON（内容不入库，只入 README 与 .gitignore）
docs/                架构决策与解析规则参考
```

## 3. 内核设计约定

- `packages/core` **不得** import 任何浏览器或 Node 专有 API；文件读取由外壳注入字节流。
- 唯一事实来源模型：`Invoice`（发票）、`LayoutSpec`（排版几何）。
- **排版只输出一次几何**（单位 pt，y 轴向下）。CSS 与 PDF 各写一个极薄适配器，
  不要把坐标系差异渗进内核（参考项目在这里踩过坑：两端各算一套、五处同步）。
- 金额一律用 **整数「分」** 表示（`number`），禁止用浮点存元。
- 取数按可信度分层：`xml/ofd` > `qr` > `pdf-text` > `ocr`，每条字段带 `source` 与 `confidence`。
- 不用绝对坐标做字段定位，用**锚点文字相对定位**（如「价税合计」「销售方名称」）。
- 人工校正走 `CorrectPatch` 的**三态**（不出现的键=不动、`null`=清空、有值=写死），
  改过的字段记成 `manual`（可信度 1），只标真的改过的字段（界面侧先 `diffPatch` 差分）。
  号码改了要清掉旧校验码。细节见 `docs/解析规则参考.md` §6。
- 打印偏移（`offsetXMm/offsetYMm`）只在 `buildLayout` 里平移槽位一次；设置读回来一律过
  `normalizeLayoutSettings()`（白名单 + 夹紧），**不许信 localStorage 里的值**。
- 解析器不抛异常：返回结果 + `issues[]`。
- 任何字段拿不到就是 `undefined`，不要用空串或 0 冒充。
- **交给 pdfjs 的字节必须先拷贝**（`data.slice()`）。pdfjs 会把 `ArrayBuffer`
  **转移**给它的 worker，转移之后调用方手里的 `Uint8Array` 就变成 detached：
  `byteLength` 静默变 0，再 `slice()/subarray()` 直接抛
  `Cannot perform Construct on a detached ArrayBuffer`。
  这个坑**只在浏览器里出现**（Node 无 worker，不转移），
  所以典型症状是「单测全绿、网页里全空」——先查这一条。
  内核侧见 `parse/pdfText.ts`，外壳侧统一走 `apps/web/src/lib/pdfjsSafe.ts`。

## 4. UI 约定

- 首屏可见按钮 ≤ 4 个；新用户到点打印 ≤ 3 次点击。
- 功能分四层：主流程（首屏）/ 次级（列表顶部小按钮）/ 高级（「更多设置」抽屉，默认关）/ 重度（独立页面）。
- 三个状态：空 / 导入后 / 有情况才出现。
- 设计稿在 `../fapiao-print` 之外的 `~/Documents/Invoice/发票工具_完整包/`，
  黄色便签是设计说明，**不要做进 UI**。

## 5. 质量

- 解析改动必须跑 `pnpm test`（内核回归，覆盖 `samples/`）。
- 字段准确率低于基线不允许合并。
- 改外壳渲染（canvas / pdfjs 画图）必须跑 `pnpm e2e` —— 无头 Chrome 里的像素级回归，
  内核单测碰不到 canvas。夹具是 pdf-lib 现场生成的，不依赖真实发票。
- 提交前 `pnpm typecheck`。

## 6. 外壳约定（桌面端）

- **页面不判断自己跑在哪儿。** 保存一律走 `apps/web/src/lib/save.ts`，打印走 `print.ts` 的
  `printPdf()`；网页版/桌面版的分流只在那一处做。谁在页面里写 `isDesktop()` 分支，谁就在制造两个分叉。
- **要像素一律走 `apps/web/src/lib/render/client.ts` 的 `renderPage()`**（默认在 Worker 里画，
  标签页不可见也算数）。不要在页面/组件里自己 `getDocument()` + `page.render()`
  —— 那会把「区域渲染参数、字体环境、内存纪律」三件事各写一遍。细节见
  `docs/打印与导出参考.md` §1.5。
- 外壳命令一律经 `apps/web/src/lib/shell.ts` 的类型化封装调，**不要直接用 `@tauri-apps/api`**：
  那条 IPC 契约（裸字节 + 百分比编码 header）有单测钉着（`shell.test.ts`），绕过去就没人守了。
- 桌面端**只补前端做不到的事**（系统对话框 / 直接读写文件 / 系统打印 / 数据目录）。
  任何解析、排版、去重逻辑出现在 `src-tauri/src/` 里都是放错了地方。
- 改 `apps/desktop/src-tauri` 之前先读 `docs/桌面端参考.md`；本机只跑 `pnpm desktop:check`。

## 7. 发布范围（Linux 不在支持范围）

发布包由 CI 出：`.github/workflows/release.yml`，推 `v*` 标签触发。
**支持两个桌面平台 + 网页版，Linux 出局**（2026-10-18 定的）：

| 平台 | 产物 | 备注 |
| --- | --- | --- |
| Windows | `invoice-tool_<版本>_windows_x64-setup.exe` | NSIS。`bundle.targets` 是 `"all"`，这里按平台收窄成 `--bundles nsis`；**不要 msi** |
| macOS | `…_darwin_aarch64.dmg` / `…_darwin_x64.dmg` | 两个架构都要。arm64 runner 上交叉编 x86_64，靠矩阵里的 `rustup target add` |
| 网页版 | `invoice-tool_<版本>_web.zip` | 静态托管即可，不需要安装 |

**Linux 为什么不支持**（实测过，别再去修）：

- rpm 打包器直接拒绝中文包名：`failed to bundle project: invalid name "发票工具":
  must start with an alphanumeric character, '_', or '%'`。要出 rpm 就得把产品名改成 ASCII
  —— 那会连带改掉 `.app` 名字、安装包与开始菜单里的显示名，不值得。
- 剩下的 deb 只有 Ubuntu 用户能直接用；AppImage 虽是发行版无关的兜底，但它 **101 MB**
  （自带一整套 GTK/WebKit 依赖），是 macOS dmg 的四倍。两个都换不来一个真正的用户群。

⚠️ CI 的 `desktop` 作业仍跑在 `ubuntu-latest` 上 —— 那只是因为**它是唯一会自动跑 `cargo test`
的地方**（本机按 §1 不许跑）。它是「测 Rust 代码」，**不是**「支持 Linux 平台」，别顺手删掉。

发布流程里几条硬规则（都是踩过的坑，别改回去）：

- **附件名必须是 ASCII**：给 tauri-action 显式写 `assetNamePattern`。中文产品名传到 GitHub 会被
  **剥掉**（`发票工具_0.1.0_x64-setup.exe` → `_0.1.0_x64-setup.exe`），而它上传前是按
  「算出来的原名」去找同名附件来决定「先删后传」的 —— 名字对不上就变成重传，
  **第二次发布必然 `already_exists`、整个作业失败**（`_*`、`invoice-tool-web-*` 与遗留的
  `*_linux_*` 由 web 作业里那一步清理）。
- **包必须自带 OCR 模型**：`public/ocr/` 是 gitignore 的（中文模型 + wasm 运行时，23 MB），
  CI 不跑 `pnpm ocr:prepare` 的话网页包只有 3.6 MB（正常 24 MB），
  「拖进扫描件 / 图片发票」这条主功能在发布包里直接不可用。每个作业都在打包前补这一步。
- **`tauriScript: pnpm tauri`，不让 action 自己猜**：它按锁文件位置判断包管理器，而
  `pnpm-lock.yaml` 在仓库根、`projectPath` 是 `apps/desktop` —— 会被猜成 npm，于是执行
  `npm run tauri build …`，npm 会在参数前插一个 `--`（pnpm 会把那个 `--` **原样**传进脚本，
  tauri 的 clap 就把 `--target` 当成了位置参数）。`pnpm tauri` 走 `apps/desktop` 的
  `tauri` 脚本 → `rust.mjs` 那道闸，照旧受 §1 管。
- **CI 里不发注解就没人看得见**：Actions 原始日志要登录才能抓（未认证
  `/actions/jobs/{id}/logs` 直接 403），只有注解是公开的。所以 `rust.mjs` 把
  「闸门拒绝 / 看门狗中止 / 进程非零退出」都发成 `::error::`（非零退出还带输出末尾 40 行），
  成功时发 `::notice::` 报峰值内存。**排查发布失败先看运行页的 Annotations 区，不用登录。**
- **CI 上跳过起飞前自检**：runner 上没有「退掉 Chrome 再回来」这个选项，实测它只会随机拦人
  （同一次发布里 aarch64 那一刻内存够就过、x86_64 就是 2.89 GB < 2.93 GB 被拦）。
  `rust.mjs` 在 `CI=true` 时跳过自检，**运行期看门狗照旧**，只是上限按 runner 给
  （矩阵里的 `maxmem`：macOS 4000 MB / Windows 8000 MB；本机默认仍是 2500 MB）。
  实测发布构建峰值：macOS 1366 / 1379 MB（Windows 采不到样 —— 那边没有 `ps`）。
- **安装包未签名**：Windows 会吃一次 SmartScreen（「更多信息」→「仍要运行」），
  macOS 首次要**右键 →「打开」**。这是证书与公证的问题，不是代码问题；README 的「下载」小节
  已写明。别为了消警告去改代码。
