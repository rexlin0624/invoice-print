//! 数据目录模块：应用自己管的文件（**库备份**与**日志**）的读写。
//!
//! 桌面版比网页版实在的地方就在这儿：网页版的「已报销库」藏在浏览器里，
//! 用户清一次浏览数据就没了；桌面版同一条记录还会落一份清单到数据目录，
//! 库被清空时能自动恢复；出问题时也有一份本地日志可以发给开发者。
//!
//! ⚠️ 名字白名单：只允许 `[A-Za-z0-9._-]` 和 `/` 分隔，且不许 `..` 开头。
//! 前端传的都是我们自己定的名字（`library-backup.json`、`logs/app.log`），
//! 这层是兜底 —— 免得哪天一个手滑就把文件写到用户主目录去。

use serde::Serialize;
use std::io::Write;
use tauri::ipc::{Request, Response};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreEntry {
    /// 相对数据目录的名字，如 `logs/app.log`
    pub name: String,
    pub size: u64,
    /// 最后修改时间（毫秒时间戳）
    pub modified: u64,
}

/// 目录里的文件清单（最多三层，够用；符号链接不展开）
#[tauri::command]
pub fn store_list(app: tauri::AppHandle) -> Result<Vec<StoreEntry>, String> {
    let dir = crate::app::ensure_data_dir(&app)?;
    let mut out: Vec<StoreEntry> = Vec::new();
    collect(&dir, "", 3, &mut out);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读一个文件；**还没有就返回空字节**（首次启动要看备份，不是错误）。
///
/// 为什么不用 `Option<Response>`：Tauri 的 `IpcResponse` 只对「`Serialize` 类型」和
/// `Response` 本身实现，`Option<Response>` 两者都不是 —— 写出来编译不过。
/// 空字节与「文件不存在」在调用侧是同一个意思（`readBackup` 就是这么判的），
/// 正好也不用为一个「没有」再造一种返回形状。
#[tauri::command]
pub async fn store_read(
    app: tauri::AppHandle,
    name: String,
) -> Result<Response, String> {
    let path = resolve(&app, &name)?;
    if !path.is_file() {
        return Ok(Response::new(Vec::new()));
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| format!("读取任务失败：{e}"))?
        .map_err(|e| format!("读不了 {name}：{e}"))?;
    Ok(Response::new(bytes))
}

/// 写一个文件（覆盖）。header：`name`。返回写入字节数。
#[tauri::command]
pub async fn store_write(app: tauri::AppHandle, request: Request<'_>) -> Result<u64, String> {
    let name = crate::files::header_str(&request, "name").ok_or("缺少 name")?;
    let bytes = crate::files::bytes_of(&request)?;
    let path = resolve(&app, &name)?;
    crate::files::write_all(&path, &bytes)
}

/// 追加（日志用）。header：`name`。文件超过 2 MB 就轮转成 `<name>.1`。
#[tauri::command]
pub async fn store_append(app: tauri::AppHandle, request: Request<'_>) -> Result<u64, String> {
    /// 单份日志上限。轮转一次就够：日志是给「最近出了什么事」用的，不是归档。
    const MAX_BYTES: u64 = 2 * 1024 * 1024;

    let name = crate::files::header_str(&request, "name").ok_or("缺少 name")?;
    let mut bytes = crate::files::bytes_of(&request)?;
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    let path = resolve(&app, &name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("建不了目录（{}）：{e}", parent.display()))?;
    }

    if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) + bytes.len() as u64 > MAX_BYTES
    {
        let rotated = path.with_file_name(format!(
            "{}.1",
            path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        ));
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&path, &rotated);
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打不开 {}：{e}", path.display()))?;
    file.write_all(&bytes)
        .map_err(|e| format!("写不了 {}：{e}", path.display()))?;
    Ok(bytes.len() as u64)
}

/// 删一个文件。不存在也算成功（要的是「删干净了」这个结果）。
#[tauri::command]
pub fn store_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = resolve(&app, &name)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|e| format!("删不掉 {}：{e}", path.display()))
}

// ------------------------------------------------------------------ 内部

fn resolve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = crate::app::ensure_data_dir(app)?;
    Ok(dir.join(validate_name(name)?))
}

/// 名字白名单：`[A-Za-z0-9._-]`，`/` 分段，不许空段、不许 `..`
fn validate_name(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("名字不能为空".to_string());
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(format!("只允许数据目录里的相对路径：{name}"));
    }
    for segment in name.split('/') {
        if segment.is_empty() {
            return Err(format!("路径里有空的层级：{name}"));
        }
        if segment == "." || segment == ".." {
            return Err(format!("路径里不能有 . 或 ..：{name}"));
        }
        for ch in segment.chars() {
            if !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')) {
                return Err(format!("文件名里有不允许的字符「{ch}」：{name}"));
            }
        }
    }
    Ok(name.to_string())
}

fn collect(dir: &std::path::Path, prefix: &str, depth: u8, out: &mut Vec<StoreEntry>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let relative = if prefix.is_empty() {
            file_name
        } else {
            format!("{prefix}/{file_name}")
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect(&entry.path(), &relative, depth - 1, out);
        } else if meta.is_file() {
            out.push(StoreEntry {
                name: relative,
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|since| since.as_millis() as u64)
                    .unwrap_or(0),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_allows_our_own_names() {
        assert!(validate_name("library-backup.json").is_ok());
        assert!(validate_name("logs/app.log").is_ok());
        assert!(validate_name("logs/app.log.1").is_ok());
    }

    #[test]
    fn validate_name_blocks_escapes() {
        assert!(validate_name("").is_err());
        assert!(validate_name("/etc/passwd").is_err());
        assert!(validate_name("../secret").is_err());
        assert!(validate_name("logs/../../secret").is_err());
        assert!(validate_name("logs//app.log").is_err());
        assert!(validate_name("日志.txt").is_err()); // 非 ASCII 一律拒绝（我们自己的名字都是 ASCII）
        assert!(validate_name("a b.txt").is_err());
    }
}
