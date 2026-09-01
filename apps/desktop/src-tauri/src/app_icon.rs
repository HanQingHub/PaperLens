//! App icon variant -> window + shortcut sync.
//! Single source of truth is frontend `app_settings.app_icon` (per-user).
//! Rust only applies side-effects (shortcut IconLocation + Shell notify + window icon).

use tauri::Manager;

#[tauri::command]
pub(crate) fn get_app_icon() -> String {
    // kept for compatibility; actual value lives in frontend store / localStorage
    "orbit".into()
}

#[tauri::command]
pub(crate) fn set_app_icon(app: tauri::AppHandle, variant: String) -> Result<Vec<String>, String> {
    let v = variant.trim().to_lowercase();
    if v != "orbit" && v != "diamond" {
        return Err(format!("invalid variant: {variant}"));
    }

    let mut report = Vec::new();

    // Resolve icon path for shortcuts & window
    let icon_path = resolve_icon_path(&app, &v);
    // Update shortcuts' IconLocation + broadcast
    match update_shortcuts_icon(&app, icon_path.as_deref()) {
        Ok(mut r) => report.append(&mut r),
        Err(e) => report.push(format!("shortcut icon error: {e}")),
    }

    // Try window icon
    match set_window_icon(&app, &v, icon_path.as_deref()) {
        Ok(msg) => {
            if !msg.is_empty() {
                report.push(msg);
            }
        }
        Err(e) => report.push(format!("window icon error: {e}")),
    }

    if report.is_empty() {
        report.push(format!("app_icon set to {v}"));
    }
    Ok(report)
}

fn resolve_icon_path(app: &tauri::AppHandle, variant: &str) -> Option<std::path::PathBuf> {
    if variant == "orbit" {
        // orbit = exe itself (bundle icon)
        return None;
    }
    // diamond -> try bundled resource icons/diamond.ico
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("resources").join("icons").join("diamond.ico");
        if p.is_file() {
            return Some(p);
        }
        // fallback: also check without resources prefix (dev mode)
        let p2 = res_dir.join("icons").join("diamond.ico");
        if p2.is_file() {
            return Some(p2);
        }
    }
    // fallback to exe (still orbit) if resource missing
    None
}

#[cfg(windows)]
fn update_shortcuts_icon(
    _app: &tauri::AppHandle,
    icon_path: Option<&std::path::Path>,
) -> Result<Vec<String>, String> {
    // Determine candidate exe (registry InstallLocation wins)
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_name = exe
        .file_name()
        .ok_or_else(|| "current_exe has no file name".to_string())?
        .to_os_string();

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

    // effective icon = icon_path (diamond) or candidate exe (orbit)
    let effective_icon = icon_path.unwrap_or(&candidate);

    // delegate to shortcut.rs helper that sets IconLocation for all lnks
    let mut r = crate::shortcut::set_shortcut_icons_for_icon(effective_icon, &candidate)?;

    // Broadcast shell association change
    unsafe {
        use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
    r.push("shell notify SHCNE_ASSOCCHANGED".into());
    Ok(r)
}

#[cfg(not(windows))]
fn update_shortcuts_icon(
    _app: &tauri::AppHandle,
    _icon_path: Option<&std::path::Path>,
) -> Result<Vec<String>, String> {
    Ok(vec!["non-windows skip".into()])
}

fn set_window_icon(
    app: &tauri::AppHandle,
    variant: &str,
    icon_path: Option<&std::path::Path>,
) -> Result<String, String> {
    // Use window.set_icon if available (tauri image feature)
    let Some(win) = app.get_webview_window("main") else {
        return Ok(String::new());
    };

    // Resolve image bytes: prefer icon_path file, otherwise try to load orbit png from resources
    // For orbit we want the bundled window icon already (exe), but we also try to set from orbit.ico for certainty
    let path_to_use: Option<std::path::PathBuf> = if let Some(p) = icon_path {
        Some(p.to_path_buf())
    } else {
        // orbit: try orbit.ico resource, fallback to exe's embedded icon (no-op)
        if let Ok(res_dir) = app.path().resource_dir() {
            let p = res_dir.join("resources").join("icons").join("orbit.ico");
            if p.is_file() {
                Some(p)
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(p) = path_to_use {
        // Load image via tauri::image::Image
        match tauri::image::Image::from_path(&p) {
            Ok(img) => {
                if let Err(e) = win.set_icon(img) {
                    return Err(format!("set_icon failed: {e}"));
                }
                return Ok(format!("window icon set to {} ({})", variant, p.display()));
            }
            Err(e) => {
                return Err(format!("Image::from_path {} failed: {e}", p.display()));
            }
        }
    }
    // no icon file -> keep default exe icon
    Ok(String::new())
}
