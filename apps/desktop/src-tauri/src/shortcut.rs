//! Shortcut self-heal: retarget stale `PaperLens.lnk` files (desktop + start
//! menu) to the registered install location.
//!
//! Belt-and-suspenders on top of the NSIS retargeting: installers before
//! 0.2.1 wrote no `MainBinaryName`, and a drifted install location (removed
//! or remapped drive) left shortcuts silently pointing at the old binary,
//! whose bundled resources then fight the new install over the fixed port.
//!
//! Retarget direction: the registry-registered install location wins over
//! the running exe — an old binary launched through the stale shortcut sees
//! `versionMismatch` in its startup check and fixes the shortcut toward the
//! NEW install, not itself.

/// Startup self-heal entry (tauri command `fix_shortcut`): returns one report
/// line per examined shortcut; empty on non-Windows.
#[tauri::command]
pub(crate) fn fix_shortcut() -> Result<Vec<String>, String> {
    fix_shortcuts()
}

#[cfg(windows)]
pub(crate) fn fix_shortcuts() -> Result<Vec<String>, String> {
    // COM apartments are per-thread: do all ShellLink work on a dedicated
    // STA thread so the tauri command thread's COM state stays untouched.
    std::thread::spawn(|| {
        let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        // S_FALSE = COM already initialized on this thread; both S_OK and
        // S_FALSE are balanced by CoUninitialize. A fresh thread never sees
        // RPC_E_CHANGED_MODE.
        let out = fix_shortcuts_inner();
        if init.is_ok() || init == HRESULT(1) {
            unsafe { CoUninitialize() };
        }
        out
    })
    .join()
    .map_err(|_| "fix_shortcuts thread panicked".to_string())?
}

#[cfg(not(windows))]
pub(crate) fn fix_shortcuts() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

/// windows 0.61 does not export the ShellLink CLSID constant; the value is
/// fixed by the shell API ({00021401-0000-0000-C000-000000000046}).
#[cfg(windows)]
const CLSID_SHELL_LINK: GUID = GUID::from_u128(0x00021401_0000_0000_c000_000000000046);

#[cfg(windows)]
fn fix_shortcuts_inner() -> Result<Vec<String>, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_name = exe
        .file_name()
        .ok_or_else(|| "current_exe has no file name".to_string())?
        .to_os_string();

    // Registry install location (written with surrounding quotes by NSIS,
    // installer.nsi "InstallLocation"); fall back to the running exe when
    // absent or when it no longer contains the main binary.
    let install_dir = crate::registry::read_registry_string(
        windows_sys::Win32::System::Registry::HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperLens",
        "InstallLocation",
    )
    .map(|v| std::path::PathBuf::from(v.trim_matches('"')))
    .filter(|dir| !dir.as_os_str().is_empty());

    let candidate = install_dir
        .filter(|dir| dir.join(&exe_name).is_file())
        .map(|dir| dir.join(&exe_name))
        .unwrap_or(exe);

    let mut report = Vec::new();
    for (label, folder) in [("desktop", &FOLDERID_Desktop), ("start menu", &FOLDERID_Programs)] {
        let dir = match known_folder_dir(folder) {
            Ok(d) => d,
            Err(e) => {
                report.push(format!("{label}: known folder unavailable ({e})"));
                continue;
            }
        };
        let lnk = dir.join("PaperLens.lnk");
        if !lnk.is_file() {
            report.push(format!("{label}: no shortcut"));
            continue;
        }
        let target = match unsafe { read_lnk_target(&lnk) } {
            Ok(t) => t,
            Err(e) => {
                report.push(format!("{label}: unreadable ({e})"));
                continue;
            }
        };
        // Skip the rewrite when the link already points at the candidate
        // (case-insensitive): keeps pins/property store untouched.
        let already = target
            .as_deref()
            .is_some_and(|t| t.to_lowercase() == candidate.to_string_lossy().to_lowercase());
        if already {
            report.push(format!("{label}: already correct"));
            continue;
        }
        if let Err(e) = unsafe { set_lnk_target(&lnk, &candidate) } {
            // Per-item failure: keep processing the remaining candidates.
            report.push(format!("{label}: retarget failed ({e})"));
            continue;
        }
        report.push(format!("{label}: retargeted to {}", candidate.display()));
    }
    Ok(report)
}

#[cfg(windows)]
fn known_folder_dir(folder: &GUID) -> Result<std::path::PathBuf, String> {
    let path = unsafe { SHGetKnownFolderPath(folder, KNOWN_FOLDER_FLAG(0), None) }
        .map_err(|e| format!("SHGetKnownFolderPath: {e}"))?;
    // Copy before freeing the shell-allocated buffer.
    let dir = unsafe { path.to_hstring() }.to_string_lossy().to_owned();
    unsafe { CoTaskMemFree(Some(path.as_ptr().cast())) };
    Ok(std::path::PathBuf::from(dir))
}

#[cfg(windows)]
fn to_wide(s: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt as _;
    s.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Rewrite only the target path of a .lnk; Load first so arguments/icon/
/// AppUserModelId survive.
#[cfg(windows)]
unsafe fn set_lnk_target(lnk: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    let lnk_w = to_wide(lnk);
    let target_w = to_wide(target);
    let link: IShellLinkW = CoCreateInstance(&CLSID_SHELL_LINK, None, CLSCTX_INPROC_SERVER)
        .map_err(|e| e.to_string())?;
    let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
    persist.Load(PCWSTR(lnk_w.as_ptr()), STGM_READ).map_err(|e| e.to_string())?;
    link.SetPath(PCWSTR(target_w.as_ptr())).map_err(|e| e.to_string())?;
    persist.Save(PCWSTR(lnk_w.as_ptr()), true).map_err(|e| e.to_string())?;
    Ok(())
}

/// Raw target path of a .lnk (SLGP_RAWPATH); None when the link has no path.
#[cfg(windows)]
unsafe fn read_lnk_target(lnk: &std::path::Path) -> Result<Option<String>, String> {
    let lnk_w = to_wide(lnk);
    let link: IShellLinkW = CoCreateInstance(&CLSID_SHELL_LINK, None, CLSCTX_INPROC_SERVER)
        .map_err(|e| e.to_string())?;
    let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
    persist.Load(PCWSTR(lnk_w.as_ptr()), STGM_READ).map_err(|e| e.to_string())?;

    let mut buf = [0u16; 260]; // MAX_PATH
    link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
        .map_err(|e| e.to_string())?;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    if len == 0 {
        return Ok(None);
    }
    Ok(Some(String::from_utf16_lossy(&buf[..len])))
}

#[cfg(windows)]
use windows::core::{GUID, Interface, HRESULT, PCWSTR};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, IPersistFile, STGM_READ,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, KNOWN_FOLDER_FLAG, SHGetKnownFolderPath,
    SLGP_RAWPATH,
};
