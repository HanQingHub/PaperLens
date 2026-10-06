//! 文件关联（默认打开方式）：HKCU 注册表 ProgID 注册 + UserChoice 直写，
//! 按扩展名配置表（AssocSpec）驱动，当前覆盖 .pdf 与 .md。
//!
//! 开启 = 注册 ProgID + OpenWithProgids（DefaultIcon 用对应徽章 ico，保持
//! 文件类型原生观感）+ 直写 FileExts\<ext>\UserChoice（哈希体系见
//! userchoice.rs，使 PaperLens 立即成为系统默认，无需系统设置确认）；
//! 直写未生效时降级为应用内「选择打开方式」模态（openas 一键拉起系统选择框，
//! 见 show_open_with；系统设置跳转兜底）。关闭 = 清理 PaperLens 写入的
//! 全部键值，不碰其他应用。

use serde::Serialize;

use crate::registry;

/// 单一扩展名的关联配置（注册表键路径均由 ext/progid 派生）。
struct AssocSpec {
    /// 带点扩展名：".pdf" / ".md"
    ext: &'static str,
    /// HKCU\Software\Classes 下的 ProgID 键名
    progid: &'static str,
    /// ProgID 默认值（资源管理器中的文件类型描述）
    desc: &'static str,
    /// DefaultIcon 回退图标（相对安装目录；系统观感探测未启用/失败时使用）
    icon_resource: &'static str,
    /// true = 探测系统默认观感图标（.pdf→Edge 图标归一）；.md 无系统默认观感
    system_icon_probe: bool,
}

const PDF_SPEC: AssocSpec = AssocSpec {
    ext: ".pdf",
    progid: "PaperLens.pdf",
    desc: "PaperLens PDF 文档",
    icon_resource: r"resources\icons\pdf-file.ico",
    system_icon_probe: true,
};

const MD_SPEC: AssocSpec = AssocSpec {
    ext: ".md",
    progid: "PaperLens.md",
    desc: "PaperLens Markdown 文档",
    icon_resource: r"resources\icons\md-file.ico",
    system_icon_probe: false,
};

const CLASSES_ROOT_KEY: &str = r"Software\Classes";

fn open_with_progids_key(ext: &str) -> String {
    format!("{CLASSES_ROOT_KEY}\\{ext}\\OpenWithProgids")
}

fn default_ext_key(ext: &str) -> String {
    format!("{CLASSES_ROOT_KEY}\\{ext}")
}

fn userchoice_key(ext: &str) -> String {
    format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}\UserChoice")
}

/// DefaultIcon 取值：system_icon_probe 时先取系统 Edge 的 PDF 图标（Windows
/// 默认 PDF 观感），把 MSEdgePDF 注册的版本化路径归一为固定 Application\msedge.exe
/// （Edge 更新删版本目录后仍有效）；探测未启用或失败时回退徽章 ico，再回退 exe 图标。
#[cfg(windows)]
fn default_icon_value(spec: &AssocSpec) -> String {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;

    if spec.system_icon_probe {
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
    }

    let exe = std::env::current_exe().ok();
    if let Some(dir) = exe.as_ref().and_then(|e| e.parent()) {
        let ico = dir.join(spec.icon_resource);
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
fn default_icon_value(_spec: &AssocSpec) -> String {
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

/// PaperLens 当前是否已注册该扩展名的关联（开关状态的权威判定）。
/// 以 ProgID 键存在为准——与 UserChoice 是否被系统重置/用户是否改默认解耦，
/// 保证开关状态跨重启保留。
#[cfg(windows)]
pub(crate) fn assoc_enabled(spec: &AssocSpec) -> bool {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    let subkey: Vec<u16> = format!("{CLASSES_ROOT_KEY}\\{}", spec.progid)
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
pub(crate) fn assoc_enabled(_spec: &AssocSpec) -> bool {
    false
}

/// 注册 ProgID + OpenWithProgids + UserChoice 直写（尽力而为）。
///
/// needs_system_ui 判定 = **行为验证**：注册后用 AssocQueryStringW 查 shell
/// 实际解析的该扩展名打开命令是否已指向本应用。指向即视为"默认已生效"
/// （无论走 UserChoice 还是"无默认 ProgID 时 OpenWithProgids 回落"路径，
/// 后者实证见于 Deny-ACL 机器——UserChoice 键带用户 Deny ACE 时直写/删键
/// 均被系统拒绝，但回落的默认行为依然成立）；未指向才降级为「选择打开
/// 方式」模态（openas 一键 / 系统设置兜底，由前端呈现）。
#[cfg(windows)]
pub(crate) fn enable_assoc(spec: &AssocSpec) -> Result<bool, String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {e}"))?
        .to_string_lossy()
        .into_owned();
    let icon = default_icon_value(spec);

    registry::write_registry_string(
        HKEY_CURRENT_USER,
        &format!("{CLASSES_ROOT_KEY}\\{}", spec.progid),
        "",
        spec.desc,
    )?;
    registry::write_registry_string(
        HKEY_CURRENT_USER,
        &format!("{CLASSES_ROOT_KEY}\\{}\\DefaultIcon", spec.progid),
        "",
        &icon,
    )?;
    registry::write_registry_string(
        HKEY_CURRENT_USER,
        &format!("{CLASSES_ROOT_KEY}\\{}\\shell\\open\\command", spec.progid),
        "",
        &format!("\"{exe}\" \"%1\""),
    )?;
    registry::write_registry_string(HKEY_CURRENT_USER, &open_with_progids_key(spec.ext), spec.progid, "")?;

    match crate::userchoice::write_user_choice(spec.ext, spec.progid) {
        Ok(()) => {}
        Err(e) => {
            // 预期内的降级路径（UserChoice 键带用户 Deny ACE 的机器）：
            // OpenWithProgids 注册本身已让默认行为生效，见行为验证
            println!("[info] userchoice direct write unavailable: {e}");
        }
    }
    notify_shell();

    let needs_system_ui = !open_command_targets_self(spec.ext);
    Ok(needs_system_ui)
}

/// shell 当前解析的该扩展名打开命令是否指向本应用可执行文件。
#[cfg(windows)]
fn open_command_targets_self(ext: &str) -> bool {
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
        .unwrap_or_default();
    if exe_name.is_empty() {
        return false;
    }
    let (cmd, _) = query_assoc(ext);
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
pub(crate) fn enable_assoc(_spec: &AssocSpec) -> Result<bool, String> {
    Ok(false)
}

/// 清理 PaperLens 写入的该扩展名全部关联键值（不碰其他应用的关联）。
/// UserChoice 仅在 ProgId 指向自身时删除——用户开启后可能又手动改默认到
/// 其他应用，其选择不被误删。
#[cfg(windows)]
pub(crate) fn disable_assoc(spec: &AssocSpec) {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    registry::delete_registry_tree(HKEY_CURRENT_USER, &format!("{CLASSES_ROOT_KEY}\\{}", spec.progid));
    registry::delete_registry_value(HKEY_CURRENT_USER, &open_with_progids_key(spec.ext), spec.progid);
    if registry::read_registry_string(HKEY_CURRENT_USER, &default_ext_key(spec.ext), "").as_deref()
        == Some(spec.progid)
    {
        registry::delete_registry_value(HKEY_CURRENT_USER, &default_ext_key(spec.ext), "");
    }
    if registry::read_registry_string(HKEY_CURRENT_USER, &userchoice_key(spec.ext), "ProgId").as_deref()
        == Some(spec.progid)
    {
        // RegDeleteTreeW 在此受保护键上会被静默拒绝，必须用 RegDeleteKeyW
        let _ = registry::delete_registry_key(HKEY_CURRENT_USER, &userchoice_key(spec.ext));
    }
    notify_shell();
}

#[cfg(not(windows))]
pub(crate) fn disable_assoc(_spec: &AssocSpec) {}

#[derive(Serialize)]
pub struct AssocResult {
    /// true = 直写默认未生效，需用户经「选择打开方式」（openas 一键）或
    /// 系统设置确认（降级路径）
    pub needs_system_ui: bool,
}

fn set_assoc(spec: &'static AssocSpec, enable: bool) -> Result<AssocResult, String> {
    if enable {
        let needs_system_ui = enable_assoc(spec)?;
        Ok(AssocResult { needs_system_ui })
    } else {
        disable_assoc(spec);
        Ok(AssocResult { needs_system_ui: false })
    }
}

#[tauri::command]
pub fn get_pdf_assoc_state() -> bool {
    assoc_enabled(&PDF_SPEC)
}

#[tauri::command]
pub fn set_pdf_assoc(enable: bool) -> Result<AssocResult, String> {
    set_assoc(&PDF_SPEC, enable)
}

#[tauri::command]
pub fn get_md_assoc_state() -> bool {
    assoc_enabled(&MD_SPEC)
}

#[tauri::command]
pub fn set_md_assoc(enable: bool) -> Result<AssocResult, String> {
    set_assoc(&MD_SPEC, enable)
}

/// ext → spec 白名单映射（命令层不接受任意扩展名）。
fn spec_for_ext(ext: &str) -> Option<&'static AssocSpec> {
    match ext {
        ".pdf" => Some(&PDF_SPEC),
        ".md" => Some(&MD_SPEC),
        _ => None,
    }
}

/// shell 当前是否已把该扩展名解析到本应用（"默认已生效"权威判定）。
#[tauri::command]
pub fn get_assoc_effective(ext: String) -> Result<bool, String> {
    let spec = spec_for_ext(&ext).ok_or_else(|| format!("unsupported ext: {ext}"))?;
    effective_for(spec)
}

#[cfg(windows)]
fn effective_for(spec: &AssocSpec) -> Result<bool, String> {
    Ok(open_command_targets_self(spec.ext))
}

#[cfg(not(windows))]
fn effective_for(_spec: &AssocSpec) -> Result<bool, String> {
    Ok(false)
}

/// openas 锚文件名（固定大小写；`collect_doc_args` 按此前缀过滤回开路径，
/// update_cleanup 按 `PaperLens-choose.*` 清扫残留）。
#[cfg(windows)]
fn anchor_file_name(ext: &str) -> String {
    format!("PaperLens-choose{ext}")
}

/// 一键拉起系统「打开方式」选择框（canonical 动词 openas，与资源管理器
/// 右键同 UI）。在 %TEMP% 准备锚文件供对话框按扩展名列出候选；用户选
/// PaperLens + 勾「始终」→ 系统亲手写入合法 UserChoice（UCPD 放行系统 UI，
/// 第三方直写在新构建已被 UCPD.sys 管控，见 enable_assoc 行为验证降级）。
///
/// 副作用契约：openas 确认后系统会用所选应用（PaperLens）打开锚文件——
/// 该路径经 `collect_doc_args` 的 `PaperLens-choose.` 前缀过滤不入队；
/// 锚文件残留由 update_cleanup 的锚文件规则启动清扫。
#[tauri::command]
#[cfg(windows)]
pub fn show_open_with(ext: String) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    let spec = spec_for_ext(&ext).ok_or_else(|| format!("unsupported ext: {ext}"))?;
    let anchor = std::env::temp_dir().join(anchor_file_name(spec.ext));
    // 上次残留先删（对话框可能仍引用旧句柄的场景由 update_cleanup 24h 规则兜底）
    let _ = std::fs::remove_file(&anchor);
    std::fs::write(&anchor, b"").map_err(|e| format!("anchor file failed: {e}"))?;

    #[repr(C)]
    struct ShellExecuteInfoW {
        cb_size: u32,
        f_mask: u32,
        hwnd: isize,
        lp_verb: *const u16,
        lp_file: *const u16,
        lp_parameters: *const u16,
        lp_directory: *const u16,
        n_show: i32,
        h_inst_app: isize,
        lp_id_list: *mut std::ffi::c_void,
        lp_class: *const u16,
        h_key_class: isize,
        dw_hot_key: u32,
        // union { hIcon, hMonitor }：两成员同尺寸，按同位宽字段保证 ABI 一致
        h_icon_or_monitor: isize,
        h_process: isize,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfoW) -> i32;
    }

    const SEE_MASK_INVOKEIDLIST: u32 = 0x0000_000C;
    const SW_SHOWNORMAL: i32 = 1;
    let verb: Vec<u16> = "openas\0".encode_utf16().collect();
    let file_os = anchor.as_os_str();
    let file: Vec<u16> = file_os.encode_wide().chain(std::iter::once(0)).collect();
    let mut info = ShellExecuteInfoW {
        cb_size: std::mem::size_of::<ShellExecuteInfoW>() as u32,
        f_mask: SEE_MASK_INVOKEIDLIST,
        hwnd: 0,
        lp_verb: verb.as_ptr(),
        lp_file: file.as_ptr(),
        lp_parameters: std::ptr::null(),
        lp_directory: std::ptr::null(),
        n_show: SW_SHOWNORMAL,
        h_inst_app: 0,
        lp_id_list: std::ptr::null_mut(),
        lp_class: std::ptr::null(),
        h_key_class: 0,
        dw_hot_key: 0,
        h_icon_or_monitor: 0,
        h_process: 0,
    };
    // BOOL 为主判据（失败时 GetLastError 诊断）；hInstApp ≤ 32 仅作 SE_ERR 码读取
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(format!("openas invoke failed: {}", std::io::Error::last_os_error()));
    }
    if info.h_inst_app <= 32 {
        return Err(format!("openas unavailable: SE_ERR {}", info.h_inst_app));
    }
    Ok(())
}

#[tauri::command]
#[cfg(not(windows))]
pub fn show_open_with(_ext: String) -> Result<(), String> {
    Err("unsupported platform".into())
}

#[cfg(test)]
mod tests {
    /// 真实 HKCU 全流程往返：enable → 行为验证（生效默认/图标）→ 状态保留
    /// → disable → 全清断言。#[ignore] 默认跳过，
    /// 诊断时 `cargo test live_registry -- --ignored --nocapture` 手动运行。
    fn live_roundtrip(spec: &'static super::AssocSpec) {
        let exe_name = std::env::current_exe()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let needs_ui = super::enable_assoc(spec).expect("enable_assoc failed");
        println!("needs_system_ui={needs_ui}");
        assert!(super::assoc_enabled(spec), "ProgID should exist after enable");

        // 行为验证：shell 解析的打开命令是否指向本测试进程。直写 UserChoice 的
        // "静默接管默认"路径依赖系统接受哈希——新版 Windows（本机 26200 实证）
        // 会拒绝用户态直写（.pdf 还可能带 Deny ACL 拒删），此时 needs_system_ui
        // 降级路径即设计行为。故此处只断言返回标志与 shell 实际解析的一致性，
        // 强断言（解析必须指向自身）仅在直写被系统接受的机器上成立，交由
        // Debug 版实机验收。
        let (cmd, icon) = super::query_assoc(spec.ext);
        println!("open-cmd={cmd}");
        println!("default-icon={icon}");
        let targets_self = cmd.to_lowercase().contains(&exe_name.to_lowercase());
        assert_ne!(needs_ui, targets_self, "needs_system_ui must mirror shell resolution");
        if targets_self {
            if spec.system_icon_probe {
                assert!(
                    icon.to_lowercase().contains("msedge.exe")
                        || icon.to_lowercase().ends_with("pdf-file.ico,0")
                        || icon.to_lowercase().contains(&exe_name.to_lowercase()),
                    "icon should be Edge PDF icon (system default look), bundled ico fallback, or exe fallback"
                );
            } else {
                assert!(
                    icon.to_lowercase().ends_with("md-file.ico,0")
                        || icon.to_lowercase().contains(&exe_name.to_lowercase()),
                    "icon should be bundled md ico fallback or exe fallback"
                );
            }
        }

        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        let uc = crate::registry::read_registry_string(
            HKEY_CURRENT_USER,
            &super::userchoice_key(spec.ext),
            "ProgId",
        );
        println!("UserChoice ProgId after enable: {uc:?}（Deny-ACL 机器上保持原值属预期降级）");

        super::disable_assoc(spec);
        assert!(!super::assoc_enabled(spec), "ProgID should be gone after disable");
        assert!(
            crate::registry::read_registry_string(HKEY_CURRENT_USER, &super::userchoice_key(spec.ext), "ProgId")
                .is_none()
                || crate::registry::read_registry_string(
                    HKEY_CURRENT_USER,
                    &super::userchoice_key(spec.ext),
                    "ProgId"
                )
                .as_deref()
                    != Some(spec.progid),
            "UserChoice should not point to PaperLens after disable",
        );
    }

    #[test]
    #[ignore]
    fn live_registry_roundtrip_pdf() {
        live_roundtrip(&super::PDF_SPEC);
    }

    #[test]
    #[ignore]
    fn live_registry_roundtrip_md() {
        live_roundtrip(&super::MD_SPEC);
    }

    /// 诊断辅助：单独跑 UserChoice 直写并打印错误（写真实注册表，跑完手动清理）。
    /// 以 .md 为样本（新路径，诊断价值最高）。
    #[test]
    #[ignore]
    fn debug_write_user_choice() {
        let r = crate::userchoice::write_user_choice(super::MD_SPEC.ext, super::MD_SPEC.progid);
        println!("write_user_choice result: {r:?}");
        let uc = crate::registry::read_registry_string(
            windows_sys::Win32::System::Registry::HKEY_CURRENT_USER,
            &super::userchoice_key(super::MD_SPEC.ext),
            "ProgId",
        );
        println!("UserChoice ProgId after write: {uc:?}");
    }

    /// 命令层扩展名白名单 + openas 锚文件名形态（固定大小写，过滤/清扫两处契约依赖）。
    #[test]
    fn spec_whitelist_and_anchor_name() {
        assert!(super::spec_for_ext(".pdf").is_some());
        assert!(super::spec_for_ext(".md").is_some());
        assert!(super::spec_for_ext(".txt").is_none());
        assert!(super::spec_for_ext(".markdown").is_none());
        assert_eq!(super::anchor_file_name(super::MD_SPEC.ext), "PaperLens-choose.md");
        assert_eq!(super::anchor_file_name(super::PDF_SPEC.ext), "PaperLens-choose.pdf");
    }
}
