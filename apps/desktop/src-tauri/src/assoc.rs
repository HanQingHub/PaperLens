//! PDF 文件关联（默认打开方式）：HKCU 注册表 ProgID 注册 + 状态查询/开关。
//!
//! 平台约束（落地计划 1.3）：Win8 起 `.pdf` 的 `UserChoice` 受系统哈希保护，
//! 程序无法静默直写默认应用——Win10+ 的合规路径是注册 ProgID + `OpenWithProgids`
//! （使 PaperLens 出现在 .pdf 的"打开方式"列表）后跳转系统设置由用户确认；
//! Win7/8 无哈希保护，直写 `HKCU\Software\Classes\.pdf` 默认值即刻生效。
//! 关闭 = 只清理 PaperLens 自身写入的键值，不碰其他应用的关联。

use serde::Serialize;

use crate::registry::read_registry_string;

const PROGID: &str = "PaperLens.pdf";
const PROGID_DESC: &str = "PaperLens PDF 文档";
const CLASSES_ROOT_KEY: &str = r"Software\Classes";
const PDF_OPEN_WITH_PROGIDS: &str = r"Software\Classes\.pdf\OpenWithProgids";
const PDF_DEFAULT_KEY: &str = r"Software\Classes\.pdf";
const PDF_USERCHOICE_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice";

/// Windows 主版本号解析（"6.1" → 6；"10.0" → 10）。
fn parse_windows_major(version: &str) -> Option<u32> {
    version.split('.').next()?.trim().parse().ok()
}

#[cfg(windows)]
fn win10_or_later() -> bool {
    // 解析失败按 Win10+ 处理：保守走"注册 + 系统设置确认"路径，
    // 避免在未知系统上直写 UserChoice 被哈希校验弹回
    read_registry_string(
        windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "CurrentVersion",
    )
    .and_then(|v| parse_windows_major(&v))
    .map(|major| major >= 10)
    .unwrap_or(true)
}

#[cfg(not(windows))]
fn win10_or_later() -> bool {
    true
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 写 REG_SZ 值（value_name 为空串 = 默认值）；键不存在则创建。
#[cfg(windows)]
fn write_registry_string(hive: windows_sys::Win32::System::Registry::HKEY, key: &str, value_name: &str, data: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCreateKeyExW, RegCloseKey, RegSetValueExW, HKEY, KEY_WRITE, REG_OPTION_NON_VOLATILE,
        REG_SZ,
    };

    let subkey = wide(key);
    let name = wide(value_name);
    let mut data16 = wide(data);
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let opened = RegCreateKeyExW(
            hive,
            subkey.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        );
        if opened != ERROR_SUCCESS {
            return Err(format!("RegCreateKeyExW failed: {opened}"));
        }
        let err = RegSetValueExW(
            hkey,
            name.as_ptr(),
            0,
            REG_SZ,
            data16.as_mut_ptr().cast(),
            (data16.len() * 2) as u32,
        );
        RegCloseKey(hkey);
        if err != ERROR_SUCCESS {
            return Err(format!("RegSetValueExW failed: {err}"));
        }
    }
    Ok(())
}

/// 删除整棵子键。
#[cfg(windows)]
fn delete_registry_tree(hive: windows_sys::Win32::System::Registry::HKEY, key: &str) {
    use windows_sys::Win32::System::Registry::{RegDeleteTreeW, HKEY};

    let subkey = wide(key);
    unsafe {
        RegDeleteTreeW(hive, subkey.as_ptr());
    }
}

/// 删除单个值（value_name 为空串 = 默认值）；值不存在时静默忽略。
#[cfg(windows)]
fn delete_registry_value(hive: windows_sys::Win32::System::Registry::HKEY, key: &str, value_name: &str) {
    use windows_sys::Win32::System::Registry::{RegDeleteValueW, RegOpenKeyExW, RegCloseKey, HKEY, KEY_WRITE};

    let subkey = wide(key);
    let name = wide(value_name);
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_WRITE, &mut hkey)
            == windows_sys::Win32::Foundation::ERROR_SUCCESS
        {
            RegDeleteValueW(hkey, name.as_ptr());
            RegCloseKey(hkey);
        }
    }
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

/// PaperLens 当前是否为 .pdf 默认打开方式。
/// UserChoice（Win7 直写 / Win10 系统设置确认后均落此）与 Classes\.pdf 默认值任一命中即算。
#[cfg(windows)]
pub(crate) fn pdf_assoc_enabled() -> bool {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    let userchoice = read_registry_string(HKEY_CURRENT_USER, PDF_USERCHOICE_KEY, "ProgId");
    if userchoice.as_deref() == Some(PROGID) {
        return true;
    }
    read_registry_string(HKEY_CURRENT_USER, PDF_DEFAULT_KEY, "") == Some(PROGID.to_string())
}

#[cfg(not(windows))]
pub(crate) fn pdf_assoc_enabled() -> bool {
    false
}

/// 注册 ProgID 并（Win7 分支）直写默认关联；返回是否需要跳系统设置确认（Win10+ 恒 true）。
#[cfg(windows)]
pub(crate) fn enable_pdf_assoc() -> Result<bool, String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {e}"))?
        .to_string_lossy()
        .into_owned();

    write_registry_string(HKEY_CURRENT_USER, &format!("{CLASSES_ROOT_KEY}\\{PROGID}"), "", PROGID_DESC)?;
    write_registry_string(
        HKEY_CURRENT_USER,
        &format!("{CLASSES_ROOT_KEY}\\{PROGID}\\DefaultIcon"),
        "",
        &format!("{exe},0"),
    )?;
    write_registry_string(
        HKEY_CURRENT_USER,
        &format!("{CLASSES_ROOT_KEY}\\{PROGID}\\shell\\open\\command"),
        "",
        &format!("\"{exe}\" \"%1\""),
    )?;
    write_registry_string(HKEY_CURRENT_USER, PDF_OPEN_WITH_PROGIDS, PROGID, "")?;

    let modern = win10_or_later();
    if !modern {
        // Win7/8：HKCU 优先于 HKLM 合并视图，直写即刻生效
        write_registry_string(HKEY_CURRENT_USER, PDF_DEFAULT_KEY, "", PROGID)?;
        write_registry_string(HKEY_CURRENT_USER, PDF_USERCHOICE_KEY, "ProgId", PROGID)?;
    }
    notify_shell();
    Ok(modern)
}

#[cfg(not(windows))]
pub(crate) fn enable_pdf_assoc() -> Result<bool, String> {
    Ok(false)
}

/// 清理 PaperLens 写入的全部关联键值（不碰其他应用的关联）。
#[cfg(windows)]
pub(crate) fn disable_pdf_assoc() {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    delete_registry_tree(HKEY_CURRENT_USER, &format!("{CLASSES_ROOT_KEY}\\{PROGID}"));
    delete_registry_value(HKEY_CURRENT_USER, PDF_OPEN_WITH_PROGIDS, PROGID);
    if read_registry_string(HKEY_CURRENT_USER, PDF_DEFAULT_KEY, "").as_deref() == Some(PROGID) {
        delete_registry_value(HKEY_CURRENT_USER, PDF_DEFAULT_KEY, "");
    }
    if read_registry_string(HKEY_CURRENT_USER, PDF_USERCHOICE_KEY, "ProgId").as_deref() == Some(PROGID)
    {
        // 仅当指向自身时删除（用户手动在系统设置里选的 PaperLens 也一并取消）
        delete_registry_tree(HKEY_CURRENT_USER, PDF_USERCHOICE_KEY);
    }
    notify_shell();
}

#[cfg(not(windows))]
pub(crate) fn disable_pdf_assoc() {}

#[derive(Serialize)]
pub struct AssocResult {
    /// true = 注册完成但需用户在系统设置中手动确认（Win10+ UserChoice 哈希保护）
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
    use super::parse_windows_major;

    #[test]
    fn version_major_parsing() {
        assert_eq!(parse_windows_major("6.1"), Some(6));
        assert_eq!(parse_windows_major("6.3"), Some(6));
        assert_eq!(parse_windows_major("10.0"), Some(10));
        assert_eq!(parse_windows_major("11"), Some(11));
        assert_eq!(parse_windows_major(""), None);
        assert_eq!(parse_windows_major("abc"), None);
    }
}
