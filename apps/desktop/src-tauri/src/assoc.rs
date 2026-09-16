//! PDF 文件关联（默认打开方式）：HKCU 注册表 ProgID 注册 + UserChoice 直写。
//!
//! 开启 = 注册 ProgID + OpenWithProgids（DefaultIcon 用自带 pdf-file.ico，
//! 保持"PDF 文件"观感）+ 直写 FileExts\.pdf\UserChoice（哈希体系见 userchoice.rs，
//! 使 PaperLens 立即成为系统默认，无需系统设置确认）；直写失败时降级为
//! 跳转系统设置由用户确认。关闭 = 清理 PaperLens 写入的全部键值，不碰其他应用。

use serde::Serialize;

use crate::registry;

const PROGID: &str = "PaperLens.pdf";
const PROGID_DESC: &str = "PaperLens PDF 文档";
const CLASSES_ROOT_KEY: &str = r"Software\Classes";
const PDF_OPEN_WITH_PROGIDS: &str = r"Software\Classes\.pdf\OpenWithProgids";
const PDF_DEFAULT_KEY: &str = r"Software\Classes\.pdf";
const PDF_USERCHOICE_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice";
const ICON_RESOURCE_REL: &str = r"resources\icons\pdf-file.ico";

/// DefaultIcon 取系统 Edge 的 PDF 图标（Windows 默认 PDF 观感），把
/// MSEdgePDF 注册的版本化路径归一为固定 Application\msedge.exe（Edge 更新
/// 删版本目录后仍有效）；Edge 不存在时回退自带 pdf-file.ico，再回退 exe 图标。
#[cfg(windows)]
fn default_icon_value() -> String {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;

    if let Some(v) = registry::read_registry_string(
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Classes\MSEdgePDF\DefaultIcon",
        "",
    ) {
        // 形如 "C:\...\Edge\Application\<ver>\msedge.exe,11" → 归一版本目录
        if let Some(app_pos) = v.to_lowercase().find(r"\application\") {
            let after_app = &v[app_pos + r"\application\".len()..];
            if let Some(sep) = after_app.find('\\') {
                // 保留版本目录后的 "\msedge.exe,<图标索引>" 尾部
                let fixed = format!("{}\\Application{}", &v[..app_pos], &after_app[sep..]);
                let exe_part = fixed.split(',').next().unwrap_or("");
                if std::path::Path::new(exe_part).is_file() {
                    return fixed;
                }
            }
        }
    }

    let exe = std::env::current_exe().ok();
    if let Some(dir) = exe.as_ref().and_then(|e| e.parent()) {
        let ico = dir.join(ICON_RESOURCE_REL);
        if ico.is_file() {
            return format!("{},0", ico.to_string_lossy());
        }
    }
    let exe_path = exe
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{exe_path},0")
}

#[cfg(not(windows))]
fn default_icon_value() -> String {
    String::new()
}

/// 关联变更后刷新资源管理器（图标/打开方式菜单即时生效）。
#[cfg(windows)]
fn notify_shell() {
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
    }
}

#[cfg(not(windows))]
fn notify_shell() {}

/// PaperLens 当前是否已注册 .pdf 关联（开关状态的权威判定）。
/// 以 ProgID 键存在为准——与 UserChoice 是否被系统重置/用户是否改默认解耦，
/// 保证开关状态跨重启保留。
#[cfg(windows)]
pub(crate) fn pdf_assoc_enabled() -> bool {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    let subkey: Vec<u16> = format!("{CLASSES_ROOT_KEY}\\{PROGID}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let opened = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey);
        if opened == ERROR_SUCCESS {
            RegCloseKey(hkey);
        }
        opened == ERROR_SUCCESS
    }
}

#[cfg(not(windows))]
pub(crate) fn pdf_assoc_enabled() -> bool {
    false
}

/// 注册 ProgID + OpenWithProgids + UserChoice 直写（尽力而为）。
///
/// needs_system_ui 判定 = **行为验证**：注册后用 AssocQueryStringW 查 shell
/// 实际解析的 .pdf 打开命令是否已指向本应用。指向即视为"默认已生效"
/// （无论走 UserChoice 还是"无默认 ProgID 时 OpenWithProgids 回落"路径，
/// 后者实证见于 Deny-ACL 机器——UserChoice 键带用户 Deny ACE 时直写/删键
/// 均被系统拒绝，但回落的默认行为依然成立）；未指向才降级跳系统设置。
#[cfg(windows)]
pub(crate) fn enable_pdf_assoc() -> Result<bool, String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {e}"))?
        .to_string_lossy()
        .into_owned();
    let icon = default_icon_value();

    registry::write_registry_string(HKEY_CURRENT_USER, &format!("{CLASSES_ROOT_KEY}\\{PROGID}"), "", PROGID_DESC)?;
    registry::write_registry_string(
        HKEY_CURRENT_USER,
        &format!("{CLASSES_ROOT_KEY}\\{PROGID}\\DefaultIcon"),
        "",
        &icon,
    )?;
    registry::write_registry_string(
        HKEY_CURRENT_USER,
        &format!("{CLASSES_ROOT_KEY}\\{PROGID}\\shell\\open\\command"),
        "",
        &format!("\"{exe}\" \"%1\""),
    )?;
    registry::write_registry_string(HKEY_CURRENT_USER, PDF_OPEN_WITH_PROGIDS, PROGID, "")?;

    match crate::userchoice::write_user_choice(".pdf", PROGID) {
        Ok(()) => {}
        Err(e) => {
            // 预期内的降级路径（UserChoice 键带用户 Deny ACE 的机器）：
            // OpenWithProgids 注册本身已让默认行为生效，见行为验证
            println!("[info] userchoice direct write unavailable: {e}");
        }
    }
    notify_shell();

    let needs_system_ui = !open_command_targets_self();
    Ok(needs_system_ui)
}

/// shell 当前解析的 .pdf 打开命令是否指向本应用可执行文件。
#[cfg(windows)]
fn open_command_targets_self() -> bool {
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
        .unwrap_or_default();
    if exe_name.is_empty() {
        return false;
    }
    let (cmd, _) = query_assoc(".pdf");
    cmd.to_lowercase().contains(&exe_name.to_lowercase())
}

/// AssocQueryStringW（ASSOCSTR_COMMAND=1）查询。
#[cfg(windows)]
fn query_assoc(ext: &str) -> (String, String) {
    #[link(name = "shlwapi")]
    extern "system" {
        fn AssocQueryStringW(
            flags: u32,
            str_id: u32,
            assoc: *const u16,
            extra: *const u16,
            out: *mut u16,
            out_len: *mut u32,
        ) -> i32;
    }
    fn q(ext: &str, str_id: u32) -> String {
        let wide: Vec<u16> = ext.encode_utf16().chain(std::iter::once(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let r = unsafe {
            AssocQueryStringW(0, str_id, wide.as_ptr(), verb.as_ptr(), buf.as_mut_ptr(), &mut len)
        };
        if r != 0 {
            return String::new();
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
        String::from_utf16_lossy(&buf[..end])
    }
    (q(ext, 1), q(ext, 15))
}

#[cfg(not(windows))]
pub(crate) fn enable_pdf_assoc() -> Result<bool, String> {
    Ok(false)
}

/// 清理 PaperLens 写入的全部关联键值（不碰其他应用的关联）。
/// UserChoice 仅在 ProgId 指向自身时删除——用户开启后可能又手动改默认到
/// WPS/Edge，其选择不被误删。
#[cfg(windows)]
pub(crate) fn disable_pdf_assoc() {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    registry::delete_registry_tree(HKEY_CURRENT_USER, &format!("{CLASSES_ROOT_KEY}\\{PROGID}"));
    registry::delete_registry_value(HKEY_CURRENT_USER, PDF_OPEN_WITH_PROGIDS, PROGID);
    if registry::read_registry_string(HKEY_CURRENT_USER, PDF_DEFAULT_KEY, "").as_deref() == Some(PROGID)
    {
        registry::delete_registry_value(HKEY_CURRENT_USER, PDF_DEFAULT_KEY, "");
    }
    if registry::read_registry_string(HKEY_CURRENT_USER, PDF_USERCHOICE_KEY, "ProgId").as_deref()
        == Some(PROGID)
    {
        // RegDeleteTreeW 在此受保护键上会被静默拒绝，必须用 RegDeleteKeyW
        let _ = registry::delete_registry_key(HKEY_CURRENT_USER, PDF_USERCHOICE_KEY);
    }
    notify_shell();
}

#[cfg(not(windows))]
pub(crate) fn disable_pdf_assoc() {}

#[derive(Serialize)]
pub struct AssocResult {
    /// true = 直写默认失败，需用户在系统设置中手动确认（降级路径）
    pub needs_system_ui: bool,
}

#[tauri::command]
pub fn get_pdf_assoc_state() -> bool {
    pdf_assoc_enabled()
}

#[tauri::command]
pub fn set_pdf_assoc(enable: bool) -> Result<AssocResult, String> {
    if enable {
        let needs_system_ui = enable_pdf_assoc()?;
        Ok(AssocResult { needs_system_ui })
    } else {
        disable_pdf_assoc();
        Ok(AssocResult { needs_system_ui: false })
    }
}

#[cfg(test)]
mod tests {
    /// 真实 HKCU 全流程往返：enable → 行为验证（生效默认/图标）→ 状态保留
    /// → disable → 全清断言。#[ignore] 默认跳过，
    /// 诊断时 `cargo test live_registry -- --ignored --nocapture` 手动运行。
    #[test]
    #[ignore]
    fn live_registry_roundtrip() {
        let exe_name = std::env::current_exe()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let needs_ui = super::enable_pdf_assoc().expect("enable_pdf_assoc failed");
        println!("needs_system_ui={needs_ui}");
        assert!(super::pdf_assoc_enabled(), "ProgID should exist after enable");

        // 行为验证：shell 解析的打开命令指向本测试进程、图标为自带 PDF 样式
        let (cmd, icon) = super::query_assoc(".pdf");
        println!("open-cmd={cmd}");
        println!("default-icon={icon}");
        assert!(
            cmd.to_lowercase().contains(&exe_name.to_lowercase()),
            "shell should resolve .pdf open command to this binary (effective default)"
        );
        assert!(
            icon.to_lowercase().contains("msedge.exe")
                || icon.to_lowercase().ends_with("pdf-file.ico,0")
                || icon.to_lowercase().contains(&exe_name.to_lowercase()),
            "icon should be Edge PDF icon (system default look), bundled ico fallback, or exe fallback"
        );

        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        let uc = crate::registry::read_registry_string(
            HKEY_CURRENT_USER,
            super::PDF_USERCHOICE_KEY,
            "ProgId",
        );
        println!("UserChoice ProgId after enable: {uc:?}（Deny-ACL 机器上保持原值属预期降级）");

        super::disable_pdf_assoc();
        assert!(!super::pdf_assoc_enabled(), "ProgID should be gone after disable");
        assert!(
            crate::registry::read_registry_string(HKEY_CURRENT_USER, super::PDF_USERCHOICE_KEY, "ProgId").is_none()
                || crate::registry::read_registry_string(
                    HKEY_CURRENT_USER,
                    super::PDF_USERCHOICE_KEY,
                    "ProgId"
                )
                .as_deref()
                    != Some(super::PROGID),
            "UserChoice should not point to PaperLens after disable",
        );
    }

    /// 诊断辅助：单独跑 UserChoice 直写并打印错误（写真实注册表，跑完手动清理）。
    #[test]
    #[ignore]
    fn debug_write_user_choice() {
        let r = crate::userchoice::write_user_choice(".pdf", super::PROGID);
        println!("write_user_choice result: {r:?}");
        let uc = crate::registry::read_registry_string(
            windows_sys::Win32::System::Registry::HKEY_CURRENT_USER,
            super::PDF_USERCHOICE_KEY,
            "ProgId",
        );
        println!("UserChoice ProgId after write: {uc:?}");
    }
}
