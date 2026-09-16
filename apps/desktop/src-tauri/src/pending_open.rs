//! 待打开 PDF 路径队列：文件关联双击 → shell 启动参数 → 前端消费。
//!
//! 设计要点（见落地计划 4.1）：队列是权威数据源，事件仅作唤醒信号——
//! 第二实例可能在 React 事件监听注册前启动，直接以事件载荷传路径会丢；
//! 前端收到信号后重新 take，冷启动路径也复用同一命令，两条路径统一。

use std::path::Path;
use std::sync::Mutex;

use tauri::State;

/// 待打开 PDF 路径队列（由 shell 启动参数或单实例回调填充）。
pub struct PendingOpens(pub Mutex<Vec<String>>);

/// 从命令行参数中过滤出真实存在的 .pdf 路径。
///
/// 规则：后缀 .pdf（不区分大小写）+ 文件真实存在。按内容过滤而非位置索引——
/// tauri-plugin-single-instance 的回调 args 含 argv0（exe 自身路径），位置法脆弱。
pub(crate) fn collect_pdf_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .map(|a| a.as_ref().trim().trim_matches('"').to_string())
        .filter(|a| {
            a.to_lowercase().ends_with(".pdf")
                && Path::new(a).is_file()
        })
        .collect()
}

/// 前端拉取并清空待打开队列（幂等：无积压时返回空数组）。
#[tauri::command]
pub fn take_pending_pdf_opens(state: State<'_, PendingOpens>) -> Vec<String> {
    let mut q = state.0.lock().unwrap();
    std::mem::take(&mut *q)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing_pdf(path: &str) -> String {
        std::fs::write(path, b"%PDF-1.4 fake").unwrap();
        path.to_string()
    }

    #[test]
    fn filters_non_pdf_and_missing_files() {
        let pdf = existing_pdf("tmp_collect_test.pdf");
        let out = collect_pdf_args([
            "paperlens-desktop.exe".to_string(),           // argv0 排除
            pdf.clone(),                                   // 存在的 pdf 保留
            "C:\\nonexistent__x\\a.pdf".to_string(),       // 不存在 → 排除
            "C:\\docs\\report.docx".to_string(),           // 非 pdf → 排除
            String::new(),                                 // 空参数 → 排除
        ]);
        assert_eq!(out, vec![pdf.clone()]);
        std::fs::remove_file(&pdf).unwrap();
    }

    #[test]
    fn case_insensitive_suffix_and_quote_trim() {
        let pdf = existing_pdf("tmp_collect_upper.PDF");
        let out = collect_pdf_args([format!("\"{pdf}\"")]);
        assert_eq!(out, vec![pdf.clone()]);
        std::fs::remove_file(&pdf).unwrap();
    }

    #[test]
    fn unicode_path_kept() {
        let pdf = existing_pdf("tmp_collect_中文路径.pdf");
        let out = collect_pdf_args([pdf.clone()]);
        assert_eq!(out, vec![pdf.clone()]);
        std::fs::remove_file(&pdf).unwrap();
    }
}
