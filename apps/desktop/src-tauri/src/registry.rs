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
