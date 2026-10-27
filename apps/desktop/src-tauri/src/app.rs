//! 应用信息模块：版本、平台、数据目录。
//!
//! 帮助对话框用它回答两个最常被问的问题：「这是哪个版本」「我的数据在哪」。
//! 数据目录是桌面版比网页版强的地方：网页版的数据藏在浏览器里（清缓存就没了），
//! 桌面版有个实实在在、能备份能打开的目录。

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub os: String,
    pub arch: String,
    /// 应用数据目录（库备份、日志都在里面）
    pub data_dir: String,
    /// 开发构建：前端据此决定要不要多显示调试入口
    pub debug: bool,
}

/// 应用信息（帮助对话框「桌面版」一栏用）
#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    let data_dir = ensure_data_dir(&app)?;
    let package = app.package_info();
    Ok(AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
        debug: cfg!(debug_assertions),
    })
}

/// 数据目录（不存在就建）。库备份、日志都放这儿 —— 用户能看见、能备份、能删。
pub(crate) fn ensure_data_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("建不了数据目录（{}）：{e}", dir.display()))?;
    // 目录里是发票备份与日志（金额、税号、票面）：Unix 下只给当前用户
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// 把主窗口叫到前面（单实例第二次启动时用）
pub(crate) fn focus_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
