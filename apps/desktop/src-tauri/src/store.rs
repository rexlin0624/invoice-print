//! 数据目录模块：应用自己管的文件（**库备份**与**日志**）的读写。
//!
//! 桌面版比网页版实在的地方就在这儿：网页版的「已报销库」藏在浏览器里，
//! 用户清一次浏览数据就没了；桌面版同一条记录还会落一份清单到数据目录，
//! 库被清空时能自动恢复；出问题时也有一份本地日志可以发给开发者。
//!
//! ⚠️ 名字白名单：**封闭清单**（`ALLOWED_NAMES`），只允许库备份与日志三个名字。
//! 不再用「字符集合法就放行」—— `logs/x.bat` 那种形状就是这么漏出去的。
//! 新增文件必须同时改清单；这层是兜底，免得哪天一个手滑就把文件写到用户主目录去。

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

/// 允许经 IPC 读写的数据目录文件名（**封闭清单**，不是字符白名单）。
///
/// 以前用「`[A-Za-z0-9._-]` + `/`」放行任意形状，于是 `logs/x.bat` 也能写进数据目录；
/// 再配合 `open_path` 就是一条执行链。应用真正用到的只有这三个名字，
/// 新增文件时必须同时改这里 —— 这比「看起来安全的字符集」可靠。
const ALLOWED_NAMES: &[&str] = &[
    "library-backup.json",
    "logs/app.log",
    "logs/app.log.1",
];

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
    // 先看大小再读：备份文件是同机可改的，被换成几十 GB 时不该先分配缓冲
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("读不了 {name}：{e}"))?
        .len();
    if size > crate::files::MAX_STORE_READ_BYTES {
        return Err(format!(
            "{name} 太大（{} MB），上限 {} MB",
            size / (1024 * 1024),
            crate::files::MAX_STORE_READ_BYTES / (1024 * 1024)
        ));
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
    crate::files::write_private(&path, &bytes)
}

/// 追加（日志用）。日志超过 2 MB 就轮转成 `logs/app.log.1`（轮转目标也在白名单里）。
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
        crate::files::ensure_private_dir(parent)?;
    }

    if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) + bytes.len() as u64 > MAX_BYTES
    {
        // 轮转目标必须也在白名单里。原来按 `<name>.1` 拼：`library-backup.json` 一旦
        // 超过 2 MB 就写出 `library-backup.json.1` —— 一个清单外的文件。
        // 只有日志会走追加，所以轮转只给日志做，目标就写死白名单里的那一个名字。
        const LOG_NAME: &str = "logs/app.log";
        if name == LOG_NAME {
            let rotated = path.with_file_name("app.log.1");
            let _ = std::fs::remove_file(&rotated);
            if std::fs::rename(&path, &rotated).is_ok() {
                // 轮转出来的那份带着旧权限；老版本留下的日志可能是 0644
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &rotated,
                        std::fs::Permissions::from_mode(0o600),
                    );
                }
            }
        }
    }

    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("打不开 {}：{e}", path.display()))?;
    // 老版本留下的日志可能是 0644：开工前先收紧，同机其他用户不该读到票面内容
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
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
    let path = dir.join(validate_name(name)?);
    // 数据目录里出现符号链接只可能是别人放的（应用自己只写普通文件）。
    // 顺着它写 = 往任意路径写，所以先拒掉。父目录也查（`logs` 被换成链接同样越界），
    // 但数据目录本身不查：用户自己把数据目录软链到别的盘是正当用法。
    if let Some(parent) = path.parent() {
        if parent != dir.as_path() && is_symlink(parent) {
            return Err(format!("拒绝写入符号链接：{}", parent.display()));
        }
    }
    if is_symlink(&path) {
        return Err(format!("拒绝写入符号链接：{}", path.display()));
    }
    Ok(path)
}

fn is_symlink(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// 名字必须在封闭清单里。不做「字符白名单」推导 —— 那只能限制形状，限制不了用途。
fn validate_name(name: &str) -> Result<String, String> {
    if ALLOWED_NAMES.contains(&name) {
        Ok(name.to_string())
    } else {
        Err(format!("不允许访问这个文件：{name}"))
    }
}

fn collect(dir: &std::path::Path, prefix: &str, depth: u8, out: &mut Vec<StoreEntry>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 不跟随符号链接：数据目录里放一个指向 `/` 的链接就能让列表递归到整块盘
        if file_type.is_symlink() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let relative = if prefix.is_empty() {
            file_name
        } else {
            format!("{prefix}/{file_name}")
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if file_type.is_dir() {
            collect(&entry.path(), &relative, depth - 1, out);
        } else if file_type.is_file() {
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
    fn validate_name_blocks_anything_not_on_the_list() {
        assert!(validate_name("").is_err());
        assert!(validate_name("/etc/passwd").is_err());
        assert!(validate_name("../secret").is_err());
        assert!(validate_name("logs/../../secret").is_err());
        assert!(validate_name("logs//app.log").is_err());
        assert!(validate_name("日志.txt").is_err());
        assert!(validate_name("a b.txt").is_err());
        // 以前这些都能过（字符集合法），再配 open_path 就是执行链
        assert!(validate_name("logs/x.bat").is_err());
        assert!(validate_name("x.cmd").is_err());
        assert!(validate_name("library-backup.json.bak").is_err());
    }
}
