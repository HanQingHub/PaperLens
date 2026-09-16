//! Windows registry access and data-directory resolution (leaf module).

use std::path::{Path, PathBuf};

/// Default data directory, consistent with the backend fallback in
/// `apps/server/app/core/config.py`. Cross-language contract: keep in sync
/// with `DEFAULT_PORT` (sidecar.rs) and the CSP in `tauri.conf.json`.
const DEFAULT_DATA_DIR: &str = r"D:\PaperLens";

/// Resolve the data directory, mirroring the backend fallback in
/// `apps/server/app/core/config.py`: explicit env wins; otherwise the
/// `HKCU\Software\PaperLens\DataDir` value written by the backend after a
/// data-dir migration; otherwise `D:\PaperLens` when the D: drive exists,
/// else `%LOCALAPPDATA%\PaperLens`.
pub(crate) fn resolve_data_dir() -> String {
    resolve_data_dir_from(
        std::env::var("PAPERLENS_DATA_DIR").ok(),
        registry_data_dir(),
        Path::new("D:\\").is_dir(),
        &std::env::var("LOCALAPPDATA").unwrap_or_default(),
    )
}

/// Pure fallback chain of `resolve_data_dir`, separated for unit tests.
fn resolve_data_dir_from(
    env_value: Option<String>,
    registry_value: Option<String>,
    has_d_drive: bool,
    localappdata: &str,
) -> String {
    if let Some(d) = env_value {
        if !d.is_empty() {
            return d;
        }
    }
    if let Some(d) = registry_value {
        return d;
    }
    if has_d_drive {
        DEFAULT_DATA_DIR.to_string()
    } else {
        PathBuf::from(localappdata)
            .join("PaperLens")
            .to_string_lossy()
            .into_owned()
    }
}

/// Data directory persisted by the backend after a migration
/// (`HKCU\Software\PaperLens\DataDir`, REG_SZ).
#[cfg(windows)]
pub(crate) fn registry_data_dir() -> Option<String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    read_registry_string(HKEY_CURRENT_USER, r"Software\PaperLens", "DataDir")
}

#[cfg(not(windows))]
pub(crate) fn registry_data_dir() -> Option<String> {
    None
}

/// Read a `REG_SZ` value from registry hive `hive`, subkey `key`.
#[cfg(windows)]
pub(crate) fn read_registry_string(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
    value_name: &str,
) -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ, REG_SZ,
    };

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let opened: WIN32_ERROR =
            RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_READ, &mut hkey);
        if opened != ERROR_SUCCESS {
            return None;
        }
        let mut ty = 0u32;
        let mut len = 0u32;
        let mut result = None;
        // Two-pass query: first for the size, then for the UTF-16 data.
        if RegQueryValueExW(
            hkey,
            value.as_ptr(),
            std::ptr::null(),
            &mut ty,
            std::ptr::null_mut(),
            &mut len,
        ) == ERROR_SUCCESS
            && ty == REG_SZ
            && len > 0
        {
            let mut buf = vec![0u16; (len as usize / 2) + 1];
            if RegQueryValueExW(
                hkey,
                value.as_ptr(),
                std::ptr::null(),
                &mut ty,
                buf.as_mut_ptr() as *mut u8,
                &mut len,
            ) == ERROR_SUCCESS
            {
                result = Some(String::from_utf16_lossy(&buf[..len as usize / 2]));
            }
        }
        RegCloseKey(hkey);
        // Defensively strip any trailing NUL from the fixed-size registry buffer.
        result.map(|s| s.trim_end_matches('\0').to_string())
    }
}

#[cfg(not(windows))]
pub(crate) fn read_registry_string(_hive: usize, _key: &str, _value_name: &str) -> Option<String> {
    None
}

/// Read a `REG_DWORD` value from registry hive `hive`, subkey `key`.
#[cfg(windows)]
pub(crate) fn read_registry_dword(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
    value_name: &str,
) -> Option<u32> {
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ, REG_DWORD,
    };

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let opened: WIN32_ERROR = RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_READ, &mut hkey);
        if opened != ERROR_SUCCESS {
            return None;
        }
        let mut ty = 0u32;
        let mut len = 0u32;
        let mut result = None;
        if RegQueryValueExW(
            hkey,
            value.as_ptr(),
            std::ptr::null(),
            &mut ty,
            std::ptr::null_mut(),
            &mut len,
        ) == ERROR_SUCCESS
            && ty == REG_DWORD
            && len == 4
        {
            let mut buf = 0u32;
            if RegQueryValueExW(
                hkey,
                value.as_ptr(),
                std::ptr::null(),
                &mut ty,
                (&mut buf as *mut u32).cast(),
                &mut len,
            ) == ERROR_SUCCESS
            {
                result = Some(buf);
            }
        }
        RegCloseKey(hkey);
        result
    }
}

#[cfg(not(windows))]
pub(crate) fn read_registry_dword(_hive: usize, _key: &str, _value_name: &str) -> Option<u32> {
    None
}

/// 写 `REG_SZ` 值（value_name 为空串 = 默认值）；键不存在则创建。
#[cfg(windows)]
pub(crate) fn write_registry_string(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
    value_name: &str,
    data: &str,
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, KEY_WRITE, REG_OPTION_NON_VOLATILE,
        REG_SZ,
    };

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut data16: Vec<u16> = data.encode_utf16().chain(std::iter::once(0)).collect();
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

/// 写 `REG_DWORD` 值；键不存在则创建。
#[cfg(windows)]
pub(crate) fn write_registry_dword(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
    value_name: &str,
    data: u32,
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, KEY_WRITE, REG_OPTION_NON_VOLATILE,
        REG_DWORD,
    };

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
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
            REG_DWORD,
            (&data as *const u32).cast(),
            4,
        );
        RegCloseKey(hkey);
        if err != ERROR_SUCCESS {
            return Err(format!("RegSetValueExW failed: {err}"));
        }
    }
    Ok(())
}

/// 删除整棵子键（UserChoice 等受保护键的唯一可行清理/重建前置路径）。
#[cfg(windows)]
pub(crate) fn delete_registry_tree(hive: windows_sys::Win32::System::Registry::HKEY, key: &str) {
    use windows_sys::Win32::System::Registry::RegDeleteTreeW;

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        RegDeleteTreeW(hive, subkey.as_ptr());
    }
}

/// SFTA 同款删键：RegDeleteKeyW（legacy 逐键删除）。受 ACL 保护的
/// FileExts UserChoice 键上 RegDeleteTreeW 会被拒（静默失败），此 API 实证可用。
/// 返回 Ok(()) 或原始错误码（诊断用）。
#[cfg(windows)]
pub(crate) fn delete_registry_key(hive: windows_sys::Win32::System::Registry::HKEY, key: &str) -> Result<(), u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::RegDeleteKeyW;

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let code = unsafe { RegDeleteKeyW(hive, subkey.as_ptr()) };
    if code == ERROR_SUCCESS { Ok(()) } else { Err(code) }
}

#[cfg(not(windows))]
pub(crate) fn delete_registry_key(_hive: usize, _key: &str) -> Result<(), u32> {
    Err(0)
}

/// 删除单个值（value_name 为空串 = 默认值）；值不存在时静默忽略。
#[cfg(windows)]
pub(crate) fn delete_registry_value(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
    value_name: &str,
) {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, KEY_WRITE,
    };

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_WRITE, &mut hkey) == ERROR_SUCCESS {
            RegDeleteValueW(hkey, name.as_ptr());
            RegCloseKey(hkey);
        }
    }
}

/// 枚举某键下全部子键名。
#[cfg(windows)]
pub(crate) fn enum_subkeys(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
) -> Vec<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, KEY_READ};

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let mut out = Vec::new();
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != ERROR_SUCCESS {
            return out;
        }
        let mut idx = 0u32;
        loop {
            let mut name = [0u16; 256];
            let mut name_len = 256u32;
            let err = RegEnumKeyExW(hkey, idx, name.as_mut_ptr(), &mut name_len, std::ptr::null_mut(),
                std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
            if err != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&name[..name_len as usize]));
            idx += 1;
        }
        RegCloseKey(hkey);
    }
    out
}

/// 枚举某键下全部值名。
#[cfg(windows)]
pub(crate) fn enum_value_names(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
) -> Vec<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, KEY_READ,
    };

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let mut out = Vec::new();
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != ERROR_SUCCESS {
            return out;
        }
        let mut idx = 0u32;
        loop {
            let mut name = [0u16; 256];
            let mut name_len = 256u32;
            let err = RegEnumValueW(hkey, idx, name.as_mut_ptr(), &mut name_len, std::ptr::null_mut(),
                std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
            if err != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&name[..name_len as usize]));
            idx += 1;
        }
        RegCloseKey(hkey);
    }
    out
}

/// 读取键 LastWriteTime（UTC FILETIME，100ns）。用于 UserChoice 写入后的
/// 跨分钟自检（系统按键 LastWriteTime 的分钟截断重算哈希校验）。
#[cfg(windows)]
pub(crate) fn query_last_write_filetime(
    hive: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
) -> Option<i64> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryInfoKeyW, HKEY, KEY_READ};

    let subkey: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != ERROR_SUCCESS {
            return None;
        }
        let mut ft = 0i64;
        let err = RegQueryInfoKeyW(
            hkey,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut ft as *mut i64 as *mut _,
        );
        RegCloseKey(hkey);
        (err == ERROR_SUCCESS).then_some(ft)
    }
}

#[cfg(not(windows))]
pub(crate) fn write_registry_string(
    _hive: usize,
    _key: &str,
    _value_name: &str,
    _data: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn write_registry_dword(
    _hive: usize,
    _key: &str,
    _value_name: &str,
    _data: u32,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn delete_registry_tree(_hive: usize, _key: &str) {}

#[cfg(not(windows))]
pub(crate) fn delete_registry_value(_hive: usize, _key: &str, _value_name: &str) {}

#[cfg(not(windows))]
pub(crate) fn enum_subkeys(_hive: usize, _key: &str) -> Vec<String> {
    Vec::new()
}

#[cfg(not(windows))]
pub(crate) fn enum_value_names(_hive: usize, _key: &str) -> Vec<String> {
    Vec::new()
}

#[cfg(not(windows))]
pub(crate) fn query_last_write_filetime(_hive: usize, _key: &str) -> Option<i64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_var_wins_over_registry_and_defaults() {
        assert_eq!(
            resolve_data_dir_from(
                Some("X:\\custom".into()),
                Some("Y:\\registry".into()),
                true,
                "C:\\Users\\t\\AppData\\Local",
            ),
            "X:\\custom"
        );
    }

    #[test]
    fn empty_env_falls_back_to_registry() {
        assert_eq!(
            resolve_data_dir_from(
                Some(String::new()),
                Some("Y:\\registry".into()),
                true,
                "C:\\Users\\t\\AppData\\Local",
            ),
            "Y:\\registry"
        );
    }

    #[test]
    fn d_drive_default_when_no_registry_value() {
        assert_eq!(
            resolve_data_dir_from(None, None, true, "C:\\Users\\t\\AppData\\Local"),
            DEFAULT_DATA_DIR
        );
    }

    #[test]
    fn localappdata_fallback_without_d_drive() {
        assert_eq!(
            resolve_data_dir_from(None, None, false, "C:\\Users\\t\\AppData\\Local"),
            "C:\\Users\\t\\AppData\\Local\\PaperLens"
        );
    }
}
