//! 打印模块：把字节写成临时 PDF，交给**系统**去打印。
//!
//! 为什么不能像网页版那样用隐藏 iframe + `window.print()`：
//! 1. `window.print()` 打的是**当前页面**（我们的界面），不是合成好的 A4 排版 PDF；
//! 2. WKWebView / WebView2 里 `<iframe src="blob:…pdf">` 根本渲染不了 PDF。
//! 所以桌面版的打印必须是原生的 —— 这也是外壳存在的理由之一。
//!
//! 两条路：
//! - **跟随系统**（默认）：Windows 走 PowerShell 的 `Start-Process -Verb Print`
//!   （由系统关联的 PDF 阅读器执行，会弹打印对话框）；macOS / Linux 走 CUPS 的 `lp`。
//! - **指定打印机**：macOS / Linux 是 `lp -d <name>`，CUPS 原生支持；
//!   Windows 需要 **SumatraPDF**（`-print-to <name>`）—— PowerShell 没有可靠的
//!   「静默打到指定打印机」的办法，`Out-Printer` 只吃文本，`Win32_PrintJob` 打不了 PDF。
//!
//! ⚠️ **指定了打印机又找不到 SumatraPDF 时，必须报错，绝不能用默认打印机顶上。**
//! 打不出来只是耽误一次；打错机器是报销季把一叠发票打到隔壁部门的打印机上。
//!
//! 失败不是死胡同：把临时文件路径回给前端，让用户点「用系统程序打开」自己打印。

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterList {
    pub printers: Vec<PrinterInfo>,
    /// 能不能「直接发到指定打印机」。Windows 上取决于有没有 SumatraPDF。
    pub direct: bool,
    /// `direct == false` 时给用户的解释（直接显示在他眼前）
    pub note: String,
}

/// 打印一段 PDF 字节。header：`name`（临时文件名，可含中文）、
/// `printer`（可选，指定打印机；不传就跟随系统、弹打印对话框）。
#[tauri::command]
pub async fn print_document(
    app: tauri::AppHandle,
    trusted: tauri::State<'_, crate::files::TrustedPaths>,
    request: Request<'_>,
) -> Result<PrintOutcome, String> {
    let bytes = crate::files::bytes_of(&request)?;
    let name = crate::files::header_str(&request, "name").unwrap_or_else(|| "票.pdf".to_string());
    let printer = crate::files::header_str(&request, "printer").filter(|v| !v.trim().is_empty());

    let path = crate::files::temp_pdf_path(&app, &name)?;
    crate::files::write_private(&path, &bytes)?;
    // 失败时前端会拿这个路径「用系统程序打开」，必须先信任
    trusted.trust(&path);
    let path_text = path.to_string_lossy().to_string();

    let (ok, message) = match hand_to_system(&path, printer.as_deref()) {
        Ok(Some(printer)) => (true, format!("已发送到打印机「{printer}」")),
        Ok(None) => (true, "已交给系统打印".to_string()),
        Err(err) => (false, format!("没能直接打印：{err}")),
    };

    // 成功后临时文件没用了，尽快删掉（里面是完整票面）。
    // Windows 的打印是异步的：阅读器可能还在读，交给 1 小时清理兜底。
    #[cfg(not(target_os = "windows"))]
    if ok {
        let _ = std::fs::remove_file(&path);
    }

    Ok(PrintOutcome {
        ok,
        message,
        path: path_text,
    })
}

/// 列出本机打印机（给设置里的下拉框用）。
#[tauri::command]
pub async fn list_printers() -> Result<PrinterList, String> {
    // PowerShell / lpstat 都是几十毫秒级的外部命令，别堵在 async 线程上
    tauri::async_runtime::spawn_blocking(probe_printers)
        .await
        .map_err(|e| format!("列打印机的任务失败：{e}"))?
}

/// 把 PDF 交给系统打印。`Ok(None)` 表示交出去了但不知道是哪个打印机。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn hand_to_system(path: &Path, printer: Option<&str>) -> Result<Option<String>, String> {
    let mut command = Command::new("lp");
    if let Some(name) = printer {
        command.args(["-d", name]);
    }
    let output = command
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

    // 指定了打印机就别去猜输出里的名字：lp 的输出格式随 CUPS 版本变，
    // 而我们本来就知道打给了谁。
    if let Some(name) = printer {
        return Ok(Some(name.to_string()));
    }
    Ok(printer_name_of(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(target_os = "windows")]
fn hand_to_system(path: &Path, printer: Option<&str>) -> Result<Option<String>, String> {
    use std::os::windows::process::CommandExt;

    // 不弹出黑框（PowerShell 会在屏幕上闪一下）
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let Some(name) = printer else {
        // 跟随系统：交给 PDF 阅读器的「打印」动作，用户自己在对话框里选打印机
        let quoted = path.to_string_lossy().replace('\'', "''");
        let script = format!("Start-Process -FilePath '{quoted}' -Verb Print");
        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("调不起 PowerShell：{e}"))?;

        return if status.success() {
            Ok(None)
        } else {
            Err("系统没有给 PDF 注册「打印」动作（装个 PDF 阅读器再试）".to_string())
        };
    };

    // 指定了打印机：只有 SumatraPDF 能可靠地直发到指定打印机。
    // 找不到就报错 —— 绝不静默改发给默认打印机（见模块头注释）。
    let exe = find_sumatra().ok_or_else(|| {
        "要指定打印机得先装 SumatraPDF（免费、免安装、解压即用），本机没找到。\
         装好后重开本应用即可；或者把打印机改回「跟随系统」用打印对话框。"
            .to_string()
    })?;

    let status = Command::new(&exe)
        .args(["-silent", "-exit-on-print", "-print-to", name])
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("调不起 SumatraPDF：{e}"))?;

    if status.success() {
        Ok(Some(name.to_string()))
    } else {
        Err(format!("SumatraPDF 没能打到「{name}」（打印机名对吗？）"))
    }
}

/// 找本机的 SumatraPDF。
///
/// 先问 `where`（PATH 里有就能找到），再试几个常见安装位置。
/// 刻意**不随包分发**它的二进制：SumatraPDF 是 GPL-3.0，随包分发就要一起提供源码，
/// 那是另一个量级的合规负担；让用户自己装一次，我们只是「调用已安装的软件」。
#[cfg(target_os = "windows")]
fn find_sumatra() -> Option<std::path::PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if let Ok(output) = Command::new("where")
        .arg("SumatraPDF.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let candidate = PathBuf::from(line.trim());
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    let mut dirs: Vec<PathBuf> = Vec::new();
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        let Ok(base) = std::env::var(key) else {
            continue;
        };
        // 安装包默认位置，以及便携版常被解压到的 `<base>\Programs\SumatraPDF`
        dirs.push(PathBuf::from(&base).join("SumatraPDF"));
        dirs.push(PathBuf::from(&base).join("Programs").join("SumatraPDF"));
    }
    for dir in dirs {
        let candidate = dir.join("SumatraPDF.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn probe_printers() -> Result<PrinterList, String> {
    let default = Command::new("lpstat")
        .arg("-d")
        .output()
        .map_err(|e| format!("调不起 lpstat（系统没装 CUPS 打印服务？）：{e}"))?;
    let default_name = lpstat_default(&String::from_utf8_lossy(&default.stdout));

    let listed = Command::new("lpstat")
        .arg("-p")
        .output()
        .map_err(|e| format!("调不起 lpstat：{e}"))?;
    let printers = lpstat_printers(
        &String::from_utf8_lossy(&listed.stdout),
        default_name.as_deref(),
    );

    Ok(PrinterList {
        printers,
        // CUPS 原生支持 `lp -d`
        direct: true,
        note: String::new(),
    })
}

#[cfg(target_os = "windows")]
fn probe_printers() -> Result<PrinterList, String> {
    // 先把输出编码钉成 UTF-8：PowerShell 5.1 默认按 OEM 代码页输出，
    // 中文打印机名会变成乱码，而打印机名是要拿去当 `-print-to` 参数的。
    let script = "$OutputEncoding=[System.Text.Encoding]::UTF8;\
                  [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\
                  Get-Printer|ForEach-Object{if($_.Default){'DEFAULT:'+$_.Name}else{$_.Name}}";
    let output = powershell(script).map_err(|e| format!("调不起 PowerShell：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let why = stderr.trim();
        return Err(if why.is_empty() {
            "读不到打印机列表（PowerShell 的 Get-Printer 失败了）".to_string()
        } else {
            why.to_string()
        });
    }

    let printers = parse_printer_lines(&String::from_utf8_lossy(&output.stdout));
    let sumatra = find_sumatra().is_some();
    let note = if sumatra {
        String::new()
    } else {
        "想直接指定打印机要先装 SumatraPDF（免费、免安装）；不装就只能用「跟随系统」弹对话框。".to_string()
    };

    Ok(PrinterList {
        printers,
        direct: sumatra,
        note,
    })
}

#[cfg(target_os = "windows")]
fn powershell(script: &str) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Windows 的输出一行一台打印机，默认那台带 `DEFAULT:` 前缀。
#[cfg(target_os = "windows")]
fn parse_printer_lines(stdout: &str) -> Vec<PrinterInfo> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        // PowerShell 2.0+ 的输出开头可能带一个 UTF-8 BOM
        let line = line.trim().trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }
        match line.strip_prefix("DEFAULT:") {
            Some(name) => out.push(PrinterInfo {
                name: name.trim().to_string(),
                is_default: true,
            }),
            None => out.push(PrinterInfo {
                name: line.to_string(),
                is_default: false,
            }),
        }
    }
    out
}

/// `system default destination: HP_LaserJet` → `HP_LaserJet`
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn lpstat_default(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let rest = line.strip_prefix("system default destination:")?;
    let name = rest.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// `printer HP_LaserJet is idle.  enabled since …` → `HP_LaserJet`
///
/// CUPS 的打印机名不含空格（空格写成 `_`），所以取第二个词就够了。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn lpstat_printers(stdout: &str, default_name: Option<&str>) -> Vec<PrinterInfo> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let mut words = line.split_whitespace();
        if words.next() != Some("printer") {
            continue;
        }
        let Some(name) = words.next() else {
            continue;
        };
        out.push(PrinterInfo {
            name: name.to_string(),
            is_default: Some(name) == default_name,
        });
    }
    out
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

    #[test]
    fn lpstat_default_reads_destination() {
        assert_eq!(
            lpstat_default("system default destination: HP_LaserJet\n"),
            Some("HP_LaserJet".to_string())
        );
        assert_eq!(lpstat_default("no system default destination"), None);
        assert_eq!(lpstat_default(""), None);
    }

    #[test]
    fn lpstat_printers_marks_the_default_one() {
        let stdout = "printer HP_LaserJet is idle.  enabled since Mon 01 Jan\n\
                      printer EPSON_XP_410 disabled since Mon 01 Jan -\n\
                      printer Canon now printing HP_LaserJet-12\n";
        let out = lpstat_printers(stdout, Some("EPSON_XP_410"));
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].name, "HP_LaserJet");
        assert!(!out[0].is_default);
        assert_eq!(out[1].name, "EPSON_XP_410");
        assert!(out[1].is_default);
        // 「now printing」这类状态行也是 `printer <name> …`，别把任务号当名字
        assert_eq!(out[2].name, "Canon");
    }

    #[test]
    fn lpstat_printers_ignores_noise() {
        assert!(lpstat_printers("no destinations added.\n", None).is_empty());
        assert!(lpstat_printers("", None).is_empty());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    #[test]
    fn parses_default_prefix() {
        let out = parse_printer_lines("\u{feff}HP LaserJet\r\nDEFAULT:Canon iR\r\n\r\n");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "HP LaserJet");
        assert!(!out[0].is_default);
        assert_eq!(out[1].name, "Canon iR");
        assert!(out[1].is_default);
    }

    #[test]
    fn empty_output_is_empty_list() {
        assert!(parse_printer_lines("").is_empty());
        assert!(parse_printer_lines("\r\n\r\n").is_empty());
    }
}
