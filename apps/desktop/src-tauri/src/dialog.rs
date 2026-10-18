//! 原生对话框模块：选发票（多选）。
//!
//! 为什么导入也用原生对话框而不是 `<input type="file">`：桌面版的 webview 里
//! 两者都是系统对话框，但原生这条**不经过 webview 的文件对象**，几 MB 的
//! 扫描件 / ZIP 不会先被复制进渲染进程再算哈希 —— 直接按路径读盘。
//!
//! ⚠️ `blocking_*` 只能在 **async 命令**里调：它内部 `run_on_main_thread` 把对话框
//! 丢回主线程再阻塞等结果。同步命令若跑在主线程上，就是死锁。
//! 另外：路径**不做白名单**，因为前端就是我们自己打包的页面（外壳可信模型）；
//! 真正需要防手滑的是 `store` 模块那种「按名字在数据目录里定位」的地方。

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub name: String,
    /// 字节数（列表里先显示体积，不用读盘）；取不到就 0
    pub size: u64,
}

/// 选发票：多选，过滤 PDF / OFD / XML / ZIP。**取消返回空数组**，不是错误。
#[tauri::command]
pub async fn pick_documents(app: tauri::AppHandle) -> Result<Vec<PickedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择发票")
        .add_filter("发票文件", &["pdf", "ofd", "xml", "zip"])
        .add_filter("全部文件", &["*"])
        .blocking_pick_files();

    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(|path| PickedFile {
            name: file_name_of(&path),
            size: std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
            path: path.to_string_lossy().to_string(),
        })
        .collect())
}

/// 从路径取文件名（给前端显示用；Windows 与 POSIX 的分隔符都认）
pub(crate) fn file_name_of(path: &std::path::Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_of_handles_both_separators() {
        assert_eq!(file_name_of(std::path::Path::new("/tmp/a/发票.pdf")), "发票.pdf");
        assert_eq!(file_name_of(std::path::Path::new("C:/x/y/票.pdf")), "票.pdf");
        assert_eq!(file_name_of(std::path::Path::new("票.pdf")), "票.pdf");
    }
}
