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

mod app;
mod dialog;
mod files;
mod print;
mod shell;
mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("发票工具启动失败");
}
