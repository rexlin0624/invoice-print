//! 打印模块：把字节写成临时 PDF，交给**系统**去打印。
//!
//! 为什么不能像网页版那样用隐藏 iframe + `window.print()`：
//! 1. `window.print()` 打的是**当前页面**（我们的界面），不是合成好的 A4 排版 PDF；
//! 2. WKWebView / WebView2 里 `<iframe src="blob:…pdf">` 根本渲染不了 PDF。
//! 所以桌面版的打印必须是原生的 —— 这也是外壳存在的理由之一。
//!
//! 打印机选择交给系统：macOS / Linux 走 CUPS 的 `lp`，Windows 走 PowerShell 的
//! `-Verb Print`（由系统关联的 PDF 阅读器执行）。**失败不是错误**：把临时文件路径
//! 回给前端，让用户点「用系统程序打开」自己打印 —— 比弹一个「打印失败」的死胡同好。

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::ipc::Request;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOutcome {
    pub ok: bool,
    /// 给用户看的一句话（成功时报出打印机名，失败时说清原因）
    pub message: String,
    /// 临时 PDF 的路径：失败时前端拿它「用系统程序打开」
    pub path: String,
}

/// 打印一段 PDF 字节。header：`name`（临时文件名，可含中文）。
#[tauri::command]
pub async fn print_document(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<PrintOutcome, String> {
    let bytes = crate::files::bytes_of(&request)?;
    let name = crate::files::header_str(&request, "name").unwrap_or_else(|| "票.pdf".to_string());

    let path = crate::files::temp_pdf_path(&app, &name)?;
    crate::files::write_all(&path, &bytes)?;
    let path_text = path.to_string_lossy().to_string();

    let (ok, message) = match hand_to_system(&path) {
        Ok(Some(printer)) => (true, format!("已发送到打印机「{printer}」")),
        Ok(None) => (true, "已交给系统打印".to_string()),
        Err(err) => (false, format!("没能直接打印：{err}")),
    };
    Ok(PrintOutcome {
        ok,
        message,
        path: path_text,
    })
}

/// 把 PDF 交给系统打印。`Ok(None)` 表示交出去了但不知道是哪个打印机。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn hand_to_system(path: &Path) -> Result<Option<String>, String> {
    let output = Command::new("lp")
        .arg(path)
        .output()
        .map_err(|e| format!("调不起系统打印命令 lp：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "系统打印命令失败（多半是没配打印机）".to_string()
        } else {
            stderr
        });
    }
    Ok(printer_name_of(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(target_os = "windows")]
fn hand_to_system(path: &Path) -> Result<Option<String>, String> {
    use std::os::windows::process::CommandExt;

    // 不弹出黑框（PowerShell 会在屏幕上闪一下）
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // 单引号是 PowerShell 的字符串定界符，路径里的单引号要写两遍
    let quoted = path.to_string_lossy().replace('\'', "''");
    let script = format!("Start-Process -FilePath '{quoted}' -Verb Print");
    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("调不起 PowerShell：{e}"))?;

    if status.success() {
        Ok(None)
    } else {
        Err("系统没有给 PDF 注册「打印」动作（装个 PDF 阅读器再试）".to_string())
    }
}

/// 从 `lp` 的输出里抠打印机名。
/// 输出长这样：`request id is HP_LaserJet_M1136-3 (1 file(s))`，
/// 其中 `-3` 是任务号（打印机名自己也可能带 `-`，所以只砍最后一段）。
/// 剩下的 `_` 与 `-` 都当分隔符换成空格 —— 那两种都是 CUPS 用来代替空格的写法。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn printer_name_of(stdout: &str) -> Option<String> {
    let rest = stdout.split("request id is").nth(1)?.trim();
    let id = rest.split_whitespace().next()?;
    let name = id.rsplit_once('-').map(|(head, _)| head).unwrap_or(id);
    let pretty = name.replace(['_', '-'], " ");
    if pretty.is_empty() {
        None
    } else {
        Some(pretty)
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    fn printer_name_comes_from_request_id() {
        assert_eq!(
            printer_name_of("request id is HP_LaserJet_M1136-3 (1 file(s))"),
            Some("HP LaserJet M1136".to_string())
        );
        // 打印机名里带 `-` 的情况：只砍任务号
        assert_eq!(
            printer_name_of("request id is EPSON-XP-410-12 (1 file(s))"),
            Some("EPSON XP 410".to_string())
        );
        assert_eq!(printer_name_of("some other output"), None);
        assert_eq!(printer_name_of(""), None);
    }
}
