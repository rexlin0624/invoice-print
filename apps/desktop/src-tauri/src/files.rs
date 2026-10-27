//! 文件模块：字节进出。
//!
//! 两个方向刻意不一样（这是 Tauri IPC 的约定，官方 fs 插件同样处理）：
//! - **读**：请求是 JSON `{ path }`，响应是**裸字节**（`Response`），前端拿到 `ArrayBuffer`；
//! - **写**：请求是**裸字节**（`Request`），文件名等元信息走 **header** ——
//!   裸字节请求体里塞不进 JSON 参数。
//!
//! header 里不能直接放中文（http header 只允许可见 ASCII），所以前端用
//! `encodeURIComponent` 编码、这里 `percent_decode` 解回来。别改成 JSON.stringify：
//! 它默认**不转义**非 ASCII，中文件名会让 `HeaderValue` 直接报错。

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 单个文件的读取上限：256 MB。真实发票（含扫描件）远小于此。
pub(crate) const MAX_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;

/// 数据目录里单个文件的读取上限（日志 2 MB、备份几 MB，64 MB 已经非常宽松）。
/// `store_read` 会把整个文件读进内存：先看声明大小，别为一个被换成几十 GB 的文件分配缓冲。
pub(crate) const MAX_STORE_READ_BYTES: u64 = 64 * 1024 * 1024;

/**
 * 本进程**自己产生/用户亲自选过**的路径。
 *
 * 渲染层能调 `read_document` / `open_path` 这类命令，但路径不能由它随便说。
 * 只有经过原生对话框（用户点了「选择」/「保存到」）或本应用写出的路径才进这个集合，
 * 命令再用时必须是集合里的项。这样即使渲染层被攻破，也读不了 `~/.ssh/id_rsa`、
 * 也打不开 `store_write` 出来的 `.bat`。
 *
 * 存储的是 `canonicalize` 后的绝对路径：符号链接、`..`、大小写别名都在这一步收敛。
 * 进程重启后集合为空 —— 用户重新选一次文件即可，宁可多一次点击。
 */
#[derive(Default)]
pub struct TrustedPaths {
    inner: Mutex<HashSet<PathBuf>>,
}

impl TrustedPaths {
    pub(crate) fn trust(&self, path: &Path) {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if let Ok(mut set) = self.inner.lock() {
            set.insert(canonical);
        }
    }

    pub(crate) fn contains(&self, path: &Path) -> bool {
        let Ok(canonical) = std::fs::canonicalize(path) else {
            return false;
        };
        self.inner
            .lock()
            .map(|set| set.contains(&canonical))
            .unwrap_or(false)
    }
}

/// 路径必须是本进程信任过的、存在的**普通文件**，且不超过读取上限。
fn trusted_file(path: &str, trusted: &TrustedPaths) -> Result<PathBuf, String> {
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Err("不接受网络路径".to_string());
    }
    if !trusted.contains(Path::new(path)) {
        return Err(format!("路径不在本次会话的可信列表里：{path}"));
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("读不了文件：{e}"))?;
    let meta = std::fs::metadata(&canonical).map_err(|e| format!("读不了文件：{e}"))?;
    if !meta.is_file() {
        return Err(format!("不是普通文件：{}", canonical.display()));
    }
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "文件太大（{} MB），上限 {} MB",
            meta.len() / (1024 * 1024),
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    Ok(canonical)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// 读一个文件的原始字节（前端拿去解析）。不经过 webview 的文件对象，大文件也不怕。
///
/// **只读本次会话里用户选过/应用写出的文件**（见 `TrustedPaths`）：
/// 路径是渲染层给的，不能当成可信输入。
#[tauri::command]
pub async fn read_document(
    path: String,
    trusted: tauri::State<'_, TrustedPaths>,
) -> Result<Response, String> {
    let target = trusted_file(&path, &trusted)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&target))
        .await
        .map_err(|e| format!("读取任务失败：{e}"))?
        .map_err(|e| format!("读不了文件：{e}"))?;
    Ok(Response::new(bytes))
}

/// 保存字节：弹保存对话框 → 写盘。**取消返回 `None`**，不是错误。
///
/// header：`name`（建议文件名，可含中文）、`filter`（扩展名，逗号分隔，如 `pdf`）。
#[tauri::command]
pub async fn save_document(
    app: tauri::AppHandle,
    trusted: tauri::State<'_, TrustedPaths>,
    request: Request<'_>,
) -> Result<Option<Written>, String> {
    let bytes = bytes_of(&request)?;
    let name = header_str(&request, "name").unwrap_or_else(|| "未命名".to_string());
    let filter = header_str(&request, "filter").unwrap_or_default();

    let mut builder = app.dialog().file().set_title("保存到").set_file_name(&name);
    let extensions: Vec<&str> = filter
        .split(',')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .collect();
    if !extensions.is_empty() {
        let label = extensions[0].to_uppercase();
        builder = builder.add_filter(label, &extensions);
    }

    let Some(path) = builder
        .blocking_save_file()
        .and_then(|file| file.into_path().ok())
    else {
        return Ok(None);
    };

    let size = write_all(&path, &bytes)?;
    // 刚写出的文件进可信集合：前端下一步「在文件夹里显示」用的就是它
    trusted.trust(&path);
    Ok(Some(Written {
        name: crate::dialog::file_name_of(&path),
        path: path.to_string_lossy().to_string(),
        size,
    }))
}

// ------------------------------------------------------------------ 给别的模块用

/// 取裸字节请求体。前端必须用 `invoke(cmd, uint8array)`（Tauri 会按 `application/octet-stream` 发）。
pub(crate) fn bytes_of(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => {
            Err("这个命令只收裸字节：前端要传 Uint8Array，别包成对象".to_string())
        }
    }
}

/// 取 header 字符串（`encodeURIComponent` 编码过的，这里解回 UTF-8）
pub(crate) fn header_str(request: &Request<'_>, key: &str) -> Option<String> {
    request
        .headers()
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(percent_decode)
}

/// `%E5%8F%91` → `发`。非法转义按原样保留（宁可文件名难看，也不要崩）。
pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_val(bytes[at + 1]), hex_val(bytes[at + 2])) {
                out.push(high * 16 + low);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 写文件（父目录不存在就建）。用于**用户明确选择**的导出位置，遵循系统 umask。
pub(crate) fn write_all(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("建不了目录（{}）：{e}", parent.display()))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("写不了文件（{}）：{e}", path.display()))?;
    Ok(bytes.len() as u64)
}

/// 建目录（不存在就建）并收紧到 `0700`。应用自己的数据目录用这个，
/// 别让同机其他用户连文件名都看不到。
pub(crate) fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("建不了目录（{}）：{e}", dir.display()))?;
    secure_dir(dir);
    Ok(())
}

/// 写应用自己管的文件（日志、备份、打印临时 PDF）：Unix 下 `0600`，目录 `0700`。
///
/// 这些文件里有发票金额、税号、完整票面，默认 `0644` 意味着同机其他用户可读。
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("写不了文件（{}）：{e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("写不了文件（{}）：{e}", path.display()))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(bytes.len() as u64)
}

#[cfg(unix)]
fn secure_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn secure_dir(_dir: &Path) {}

/// 打印临时文件路径。**每次打印换一个文件名**：打印是异步的（打印驱动还在读），
/// 覆盖上一次的文件可能把排着队的任务弄坏。顺手清理 1 小时前的旧文件。
pub(crate) fn temp_pdf_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
) -> Result<PathBuf, String> {
    let dir = print_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("建不了打印临时目录（{}）：{e}", dir.display()))?;
    secure_dir(&dir);
    cleanup_old(&dir);

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("{stamp}-{}", sanitize_file_name(name))))
}

/// 清掉打印临时目录里超过 1 小时的文件。启动时也调一次：只打印过一次就再没打印的
/// 用户，不该把一份合并好的发票 PDF 永久留在缓存目录里。
pub(crate) fn cleanup_print_cache<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(dir) = print_dir(app) {
        cleanup_old(&dir);
    }
}

fn print_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("拿不到缓存目录：{e}"))?
        .join("print"))
}

fn cleanup_old(dir: &Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified.elapsed().map(|age| age > MAX_AGE).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 文件名洗干净：去掉路径分隔符与 Windows 的保留字符，限长，补 `.pdf`。
/// 前端传的是「发票合并打印.pdf」这类我们自己定的名字，这里是兜底。
pub(crate) fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut cleaned = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            cleaned.push('_');
        } else {
            cleaned.push(ch);
        }
    }
    let trimmed = cleaned
        .trim()
        .trim_end_matches(['.', ' '])
        .trim_start_matches('.')
        .to_string();
    if trimmed.is_empty() {
        return "票.pdf".to_string();
    }
    let capped: String = trimmed.chars().take(80).collect();
    // Windows 把 `CON`、`NUL`、`COM1` 之类当设备名：判定看的是**第一个点之前**那一段 ——
    // `CON.pdf`、`CON.tar.pdf` 都是设备 `CON`，只剥 `.pdf` 后缀会漏掉后者。加前缀比报错好。
    let device = capped
        .split('.')
        .next()
        .unwrap_or(&capped)
        .trim()
        .to_uppercase();
    let reserved = matches!(
        device.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    let capped = if reserved { format!("_{capped}") } else { capped };
    if capped.to_lowercase().ends_with(".pdf") {
        capped
    } else {
        format!("{capped}.pdf")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_reads_utf8_bytes() {
        assert_eq!(percent_decode("%E5%8F%91%E7%A5%A8.pdf"), "发票.pdf");
        assert_eq!(percent_decode("plain.pdf"), "plain.pdf");
    }

    #[test]
    fn percent_decode_keeps_broken_escapes() {
        // 半截转义、非十六进制：原样留着，别丢字符也别崩
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("100%zz"), "100%zz");
        assert_eq!(percent_decode("%"), "%");
    }

    #[test]
    fn sanitize_strips_paths_and_reserved_chars() {
        assert_eq!(sanitize_file_name("发票合并打印.pdf"), "发票合并打印.pdf");
        // 只取最后一段：前面的路径丢掉，免得写到别的目录
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd.pdf");
        assert_eq!(sanitize_file_name("a:b*c?.pdf"), "a_b_c_.pdf");
        assert_eq!(sanitize_file_name("   "), "票.pdf");
        assert_eq!(sanitize_file_name(".hidden"), "hidden.pdf");
    }

    #[test]
    fn sanitize_prefixes_windows_device_names() {
        // 设备名判定看第一个点之前那一段：带几层扩展名都还是设备
        assert_eq!(sanitize_file_name("CON"), "_CON.pdf");
        assert_eq!(sanitize_file_name("con.pdf"), "_con.pdf");
        assert_eq!(sanitize_file_name("CON.tar.pdf"), "_CON.tar.pdf");
        assert_eq!(sanitize_file_name("LPT9.2024"), "_LPT9.2024.pdf");
        // 只是以设备名开头的不算
        assert_eq!(sanitize_file_name("CONTRACT.pdf"), "CONTRACT.pdf");
        assert_eq!(sanitize_file_name("COM10.pdf"), "COM10.pdf");
    }

    #[test]
    fn sanitize_caps_length() {
        let long = "票".repeat(200);
        let out = sanitize_file_name(&long);
        assert!(out.ends_with(".pdf"));
        assert_eq!(out.chars().count(), 84); // 80 个字符 + ".pdf"
    }
}
