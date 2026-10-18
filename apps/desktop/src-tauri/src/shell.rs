//! 「交给系统」模块：在文件管理器里显示、用默认程序打开。
//!
//! 这两个动作看着不起眼，但它们让外壳**没有死胡同**：
//! - 保存完 → 「在文件夹里显示」（用户马上知道东西存哪了）
//! - 打印失败 → 「用系统程序打开」（自己按 ⌘P / Ctrl+P 打）
//! - 帮助里 → 「打开数据目录」（备份 / 清理 / 把日志发给开发者）
//!
//! 刻意不引 `tauri-plugin-opener`：每个平台就一条命令，不值得多一个依赖。

use std::path::PathBuf;

/// 在文件管理器里显示（macOS 的访达会直接选中它）
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = existing(&path)?;

    #[cfg(target_os = "macos")]
    return launch("open", &["-R", &target]);
    #[cfg(target_os = "windows")]
    return launch("explorer", &[&format!("/select,{target}")]);
    #[cfg(all(unix, not(target_os = "macos")))]
    return launch("xdg-open", &[&parent_of(&target)]);
}

/// 用系统默认程序打开（PDF 会进系统阅读器）
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let target = existing(&path)?;

    #[cfg(target_os = "macos")]
    return launch("open", &[&target]);
    #[cfg(target_os = "windows")]
    return launch("powershell", &["-NoProfile", "-Command", &format!("Start-Process '{target}'")]);
    #[cfg(all(unix, not(target_os = "macos")))]
    return launch("xdg-open", &[&target]);
}

/// 先确认路径存在：把一个不存在的路径交给系统命令，用户看到的会是一句英文报错
fn existing(path: &str) -> Result<String, String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(format!("路径不存在：{}", target.display()));
    }
    Ok(target.to_string_lossy().to_string())
}

/// 上层目录（Linux 的文件管理器没有统一的「选中某个文件」入口，只能打开所在目录）
#[cfg(all(unix, not(target_os = "macos")))]
fn parent_of(target: &str) -> String {
    target
        .rsplit_once('/')
        .map(|(head, _)| head.to_string())
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
    fn existing_rejects_missing_paths() {
        let err = existing("/no/such/path/发票.pdf").unwrap_err();
        assert!(err.contains("路径不存在"), "{err}");
    }
}
