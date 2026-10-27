//! 「交给系统」模块：在文件管理器里显示、用默认程序打开。
//!
//! 这两个动作看着不起眼，但它们让外壳**没有死胡同**：
//! - 保存完 → 「在文件夹里显示」（用户马上知道东西存哪了）
//! - 打印失败 → 「用系统程序打开」（自己按 ⌘P / Ctrl+P 打）
//! - 帮助里 → 「打开数据目录」（备份 / 清理 / 把日志发给开发者）
//!
//! 刻意不引 `tauri-plugin-opener`：每个平台就一条命令，不值得多一个依赖。

use std::path::{Path, PathBuf};

use crate::files::TrustedPaths;

/** 打开/显示的文件扩展名白名单：应用只会产出 PDF（打印临时文件/保存的合并票） */
const OPENABLE_EXTENSIONS: &[&str] = &["pdf"];

/// 在文件管理器里显示（macOS 的访达会直接选中它）
///
/// 允许两种路径：本应用信任的（用户选的/我们写的），以及**数据目录里的任意项**
/// （帮助页的「打开数据目录」）。其他一律拒绝。
#[tauri::command]
pub fn reveal_path(
    app: tauri::AppHandle,
    trusted: tauri::State<'_, TrustedPaths>,
    path: String,
) -> Result<(), String> {
    let target = canonical_existing(&path)?;
    // Linux 只打开所在目录（见 `parent_of`），用不到字符串形式；不 cfg 掉会是未使用变量警告
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let target_text = target.to_string_lossy().to_string();
    if !trusted.contains(&target) && !inside_data_dir(&app, &target) {
        return Err(format!("路径不在可信任范围里：{path}"));
    }

    #[cfg(target_os = "macos")]
    return launch("open", &["-R", &target_text]);
    #[cfg(target_os = "windows")]
    return launch("explorer", &[&format!("/select,{target_text}")]);
    #[cfg(all(unix, not(target_os = "macos")))]
    return launch("xdg-open", &[&parent_of(&target)]);
}

/// 用系统默认程序打开（PDF 会进系统阅读器）
///
/// 只认**本会话里由对话框/应用写出**的路径，且必须是 PDF 普通文件。
/// 这条限制挡的是「`store_write` 一个 `.bat` 再 `open_path`」这类借壳执行。
#[tauri::command]
pub fn open_path(
    trusted: tauri::State<'_, TrustedPaths>,
    path: String,
) -> Result<(), String> {
    let target = canonical_existing(&path)?;
    let target_text = target.to_string_lossy().to_string();
    if !trusted.contains(&target) {
        return Err(format!("路径不在本次会话的可信列表里：{path}"));
    }
    let meta = std::fs::metadata(&target).map_err(|e| format!("读不了文件：{e}"))?;
    if !meta.is_file() {
        return Err(format!("不是普通文件：{}", target.display()));
    }
    let extension = target
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !OPENABLE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("只允许用系统程序打开 PDF：{}", target.display()));
    }

    #[cfg(target_os = "macos")]
    return launch("open", &[&target_text]);
    #[cfg(target_os = "windows")]
    {
        let script = powershell_start_process(&target_text);
        return launch(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    return launch("xdg-open", &[&target_text]);
}

/// PowerShell 单引号字符串：路径里的 `'` 必须写成 `''`。
///
/// `print.rs` 里打印也遵循同一条转义规则；单独提出来是为了能在非 Windows
/// 机器上跑单测，避免这条安全规则只存在于 `#[cfg(windows)]` 分支里。
#[cfg(any(target_os = "windows", test))]
fn powershell_start_process(target: &str) -> String {
    format!("Start-Process -FilePath '{}'", target.replace('\'', "''"))
}

/// 先确认路径存在并规范化。UNC 路径一律拒绝：Windows 上访问 `\\attacker\share`
/// 会触发 SMB 认证（NTLM 哈希外带），而发票工具永远不需要网络路径。
fn canonical_existing(path: &str) -> Result<PathBuf, String> {
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Err("不接受网络路径".to_string());
    }
    let target = std::fs::canonicalize(path).map_err(|_| format!("路径不存在：{path}"))?;
    if !target.exists() {
        return Err(format!("路径不存在：{}", target.display()));
    }
    Ok(target)
}

/** 是否在应用数据目录里（帮助页「打开数据目录」用） */
fn inside_data_dir(app: &tauri::AppHandle, target: &Path) -> bool {
    let Ok(dir) = crate::app::ensure_data_dir(app) else {
        return false;
    };
    let Ok(dir) = std::fs::canonicalize(dir) else {
        return false;
    };
    target.starts_with(dir)
}

/// 上层目录（Linux 的文件管理器没有统一的「选中某个文件」入口，只能打开所在目录）
#[cfg(all(unix, not(target_os = "macos")))]
fn parent_of(target: &Path) -> String {
    target
        .parent()
        .map(|dir| dir.to_string_lossy().to_string())
        .filter(|head| !head.is_empty())
        .unwrap_or_else(|| "/".to_string())
}

#[cfg(target_os = "macos")]
fn launch(command: &str, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(command)
        .args(args)
        .status()
        .map_err(|e| format!("调不起 {command}：{e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{command} 返回失败（{}）", status.code().unwrap_or(-1)))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launch(command: &str, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(command)
        .args(args)
        .status()
        .map_err(|e| format!("调不起 {command}：{e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{command} 返回失败（{}）", status.code().unwrap_or(-1)))
    }
}

/// Windows：只起进程不等退出（explorer 会一直挂着），并且**不弹黑框**
#[cfg(target_os = "windows")]
fn launch(command: &str, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(command)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("调不起 {command}：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_existing_rejects_missing_paths() {
        let err = canonical_existing("/no/such/path/发票.pdf").unwrap_err();
        assert!(err.contains("路径不存在"), "{err}");
    }

    #[test]
    fn canonical_existing_rejects_unc_paths() {
        assert!(canonical_existing(r"\\attacker\share\a.pdf").is_err());
        assert!(canonical_existing("//attacker/share/a.pdf").is_err());
    }

    #[test]
    fn powershell_start_process_escapes_single_quotes() {
        assert_eq!(
            powershell_start_process(r"C:\tmp\发票.pdf"),
            r"Start-Process -FilePath 'C:\tmp\发票.pdf'"
        );
        assert_eq!(
            powershell_start_process(r"C:\tmp\a'; calc; '.pdf"),
            r"Start-Process -FilePath 'C:\tmp\a''; calc; ''.pdf'"
        );
    }
}
