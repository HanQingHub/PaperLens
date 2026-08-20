//! PaperLens desktop shell (Tauri v2 thin shell).
//!
//! Responsibilities:
//! - Spawn the `paperlens-server` sidecar with a boot handshake token and the data dir.
//! - Attach the sidecar to a Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
//!   so the entire sidecar process tree dies when the shell exits
//!   (tauri-plugin-shell's `kill` only terminates the direct child).
//! - Persist the handshake token to `{data dir}\.token` for the sidecar to pick up.
//!
//! Module layout (dependency direction, `registry` is the leaf):
//! - `registry`: registry reads + data-dir resolution
//! - `sidecar`: backend process management (token handshake, Job Object)
//! - `proxy`: system-proxy injection
//! - `updater_check`: startup self-check
//! - `update_cleanup`: stale updater temp package cleanup

mod proxy;
mod registry;
mod sidecar;
mod update_cleanup;
mod updater_check;

use std::path::Path;

use tauri::RunEvent;

/// Expose the resolved data directory to the settings UI.
#[tauri::command]
fn get_data_dir() -> String {
    registry::resolve_data_dir()
}

/// Record panics to `{data dir}\crash.log`. Release builds strip symbols
/// (`profile.release.strip`), so this log line is the only crash trace left.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let dir = registry::resolve_data_dir();
        if std::fs::create_dir_all(&dir).is_ok() {
            use std::io::Write as _;
            let path = Path::new(&dir).join("crash.log");
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = writeln!(f, "[panic] {info}");
            }
        }
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    #[cfg(windows)]
    proxy::inject_system_proxy();
    // Background sweep of leftover updater packages in %TEMP% (never blocks startup).
    std::thread::spawn(|| {
        update_cleanup::cleanup_stale_update_installers(std::time::SystemTime::now());
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![updater_check::startup_check, get_data_dir])
        .setup(sidecar::setup_sidecar)
        .build(tauri::generate_context!())
        .expect("error while building PaperLens window")
        .run(|app_handle, event| {
            // Two-step exit policy: the graceful HTTP shutdown step
            // is skipped because the backend has no shutdown endpoint; closing
            // the Job Object handle cascade-kills the whole sidecar tree.
            if let RunEvent::ExitRequested { .. } = event {
                sidecar::shutdown_sidecar(app_handle);
            }
        });
}