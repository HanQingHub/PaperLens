//! Auto-update: startup self-check (design doc P1-6 + resources integrity).
//! The updater plugin itself does not verify that a silent install succeeded,
//! so on boot we compare the NSIS-registered version with the running app and
//! verify the bundled resources survived the update (they must be preserved by
//! the resources-free update package).

use tauri::Manager;

/// Result of the startup self-check, consumed by the frontend updater module.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupCheck {
    /// Whether an NSIS installation is registered (false in `tauri dev`).
    installed: bool,
    /// Version registered by the installer (HKCU Uninstall\PaperLens).
    installed_version: Option<String>,
    /// Version of the running binary (tauri.conf.json).
    app_version: String,
    /// Installer version differs from the running one → last update did not finish.
    version_mismatch: bool,
    /// Missing bundled resource entries, e.g. "resources/ecdict.db".
    missing_resources: Vec<String>,
}

#[tauri::command]
pub(crate) fn startup_check(app: tauri::AppHandle) -> StartupCheck {
    let app_version = app.package_info().version.to_string();

    // debug/debugger 构建跳过自检：其运行版本与注册表安装版本天然脱钩
    // （注册表跟随正式安装器走），mismatch 属预期噪音而非真实故障。
    #[cfg(debug_assertions)]
    return StartupCheck {
        installed: false,
        installed_version: None,
        app_version,
        version_mismatch: false,
        missing_resources: Vec::new(),
    };

    #[cfg(not(debug_assertions))]
    {
        #[cfg(windows)]
        let installed_version = read_installed_version();
        #[cfg(not(windows))]
        let installed_version: Option<String> = None;

        let installed = installed_version.is_some();
        let version_mismatch = installed_version.as_deref().is_some_and(|v| v != app_version);

        // Skip the resources check in dev mode: resource_dir() points at
        // target/debug there and never contains the bundled resources.
        let missing_resources = if installed {
            check_resources(&app)
        } else {
            Vec::new()
        };

        StartupCheck {
            installed,
            installed_version,
            app_version,
            version_mismatch,
            missing_resources,
        }
    }
}

/// Read `DisplayVersion` from the currentUser uninstall registry key written
/// by our NSIS template (installMode=currentUser → SHCTX = HKCU).
#[cfg(windows)]
fn read_installed_version() -> Option<String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    crate::registry::read_registry_string(
        HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperLens",
        "DisplayVersion",
    )
}

#[cfg(not(windows))]
fn read_installed_version() -> Option<String> {
    None
}

/// Verify the install-dir resources tree laid out by `bundle.resources`
/// (mirrors the env vars injected in `setup_sidecar`).
fn check_resources(app: &tauri::AppHandle) -> Vec<String> {
    let mut missing = Vec::new();
    let Ok(res_dir) = app.path().resource_dir() else {
        return missing;
    };
    let root = res_dir.join("resources");

    if !root.join("ecdict.db").is_file() {
        missing.push("resources/ecdict.db".into());
    }

    let models = root.join("models");
    let has_model = std::fs::read_dir(&models).is_ok_and(|mut entries| {
        entries.any(|e| {
            e.is_ok_and(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("gguf")))
        })
    });
    if !has_model {
        missing.push("resources/models (GGUF)".into());
    }

    if !root.join("paperlens-ocr").join("paperlens-ocr.exe").is_file() {
        missing.push("resources/paperlens-ocr".into());
    }

    missing
}