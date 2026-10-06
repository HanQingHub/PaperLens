//! 待打开文档路径队列（.pdf/.md/.markdown）：文件关联双击 → shell 启动参数 → 前端消费。
//!
//! 设计要点（见落地计划 4.1）：队列是权威数据源，事件仅作唤醒信号——
//! 第二实例可能在 React 事件监听注册前启动，直接以事件载荷传路径会丢；
//! 前端收到信号后重新 take，冷启动路径也复用同一命令，两条路径统一。

use std::path::Path;
use std::sync::Mutex;

use tauri::State;

/// 待打开文档路径队列（由 shell 启动参数或单实例回调填充）。
pub struct PendingOpens(pub Mutex<Vec<String>>);

/// 从命令行参数中过滤出真实存在的文档路径（.pdf/.md/.markdown）。
///
/// 规则：后缀 .pdf/.md/.markdown（不区分大小写）+ 文件真实存在 + 文件名非
/// openas 锚文件（`PaperLens-choose.*`，大小写不敏感；关联「选择打开方式」
/// 确认后系统会用 PaperLens 回开锚文件，该路径不入队落库，见 assoc.rs
/// show_open_with）。按内容过滤而非位置索引——tauri-plugin-single-instance
/// 的回调 args 含 argv0（exe 自身路径），位置法脆弱。
pub(crate) fn collect_doc_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .map(|a| a.as_ref().trim().trim_matches('"').to_string())
        .filter(|a| {
            let lower = a.to_lowercase();
            let is_anchor = Path::new(a)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.to_lowercase().starts_with("paperlens-choose."));
            !is_anchor
                && (lower.ends_with(".pdf") || lower.ends_with(".md") || lower.ends_with(".markdown"))
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

    fn existing_md(path: &str) -> String {
        std::fs::write(path, b"# notes").unwrap();
        path.to_string()
    }

    #[test]
    fn filters_non_doc_and_missing_files() {
        let pdf = existing_pdf("tmp_collect_test.pdf");
        let md = existing_md("tmp_collect_notes.md");
        let mdown = existing_md("tmp_collect_readme.markdown");
        let out = collect_doc_args([
            "paperlens-desktop.exe".to_string(),           // argv0 排除
            pdf.clone(),                                   // 存在的 pdf 保留
            md.clone(),                                    // 存在的 md 保留
            mdown.clone(),                                 // 存在的 .markdown 保留
            "C:\\nonexistent__x\\a.pdf".to_string(),       // 不存在 → 排除
            "C:\\docs\\report.docx".to_string(),           // 非 pdf/md → 排除
            "C:\\docs\\note.txt".to_string(),              // 非 pdf/md → 排除
            String::new(),                                 // 空参数 → 排除
        ]);
        assert_eq!(out, vec![pdf.clone(), md.clone(), mdown.clone()]);
        std::fs::remove_file(&pdf).unwrap();
        std::fs::remove_file(&md).unwrap();
        std::fs::remove_file(&mdown).unwrap();
    }

    #[test]
    fn case_insensitive_suffix_and_quote_trim() {
        let pdf = existing_pdf("tmp_collect_upper.PDF");
        let md = existing_md("tmp_collect_upper.MD");
        let out = collect_doc_args([format!("\"{pdf}\""), format!("\"{md}\"")]);
        assert_eq!(out, vec![pdf.clone(), md.clone()]);
        std::fs::remove_file(&pdf).unwrap();
        std::fs::remove_file(&md).unwrap();
    }

    #[test]
    fn unicode_path_kept() {
        let pdf = existing_pdf("tmp_collect_中文路径.pdf");
        let out = collect_doc_args([pdf.clone()]);
        assert_eq!(out, vec![pdf.clone()]);
        std::fs::remove_file(&pdf).unwrap();
    }

    #[test]
    fn anchor_file_excluded() {
        // openas 锚文件回开路径：真实存在 + 合法后缀，但按文件名前缀排除（不区分大小写）
        let anchor = existing_md("PaperLens-choose.md");
        let anchor_pdf = existing_pdf("PaperLens-choose.PDF");
        let md = existing_md("tmp_collect_normal.md");
        let out = collect_doc_args([anchor.clone(), anchor_pdf.clone(), md.clone()]);
        assert_eq!(out, vec![md.clone()]);
        std::fs::remove_file(&anchor).unwrap();
        std::fs::remove_file(&anchor_pdf).unwrap();
        std::fs::remove_file(&md).unwrap();
    }
}
