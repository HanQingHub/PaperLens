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
//! - `shortcut`: shortcut self-heal (retarget stale .lnk to registered install)
//! - `update_cleanup`: stale updater temp package cleanup

mod app_icon;
mod proxy;
mod registry;
mod shortcut;
mod sidecar;
mod update_cleanup;
mod updater_check;

use std::path::Path;

use tauri::{Manager, RunEvent};

/// Expose the resolved data directory to the settings UI.
#[tauri::command]
fn get_data_dir() -> String {
    registry::resolve_data_dir()
}

/// Open an external link in the system browser (PDF external links).
/// Only http/https are allowed; tauri-plugin-shell's `open` is deprecated in
/// favor of the opener plugin but kept here to avoid a new plugin dependency.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("unsupported url scheme".into());
    }
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
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
        // 单实例必须最先注册（插件约定）：二次启动聚焦既有窗口，
        // 防止第二个实例抢占固定端口 8737 并并发写同一 SQLite 数据目录
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            updater_check::startup_check,
            shortcut::fix_shortcut,
            app_icon::get_app_icon,
            app_icon::set_app_icon,
            get_data_dir,
            open_external
        ])
        .setup(|app| {
            // 撤销 tao 在顶层窗口注册的 OLE FileDropHandler。tao 默认 drag_and_drop=true
            // 且 tauri 未暴露关闭入口（dragDropEnabled 仅控制 wry 的 webview 层 handler），
            // 该 handler 会吞掉一切 OLE 拖拽，导致 WebView2 内 HTML5 drag-and-drop
            // （文库卡片排序 / PDF 文件投放）在 Windows 打包版中完全失效。
            // 副作用：tauri://drag-* 原生事件不再触发——本项目未使用。
            #[cfg(windows)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(h) = w.hwnd() {
                        unsafe {
                            #[link(name = "ole32")]
                            extern "system" {
                                fn RevokeDragDrop(hwnd: *mut core::ffi::c_void) -> i32;
                            }
                            let _ = RevokeDragDrop(h.0);
                        }
                    }
                }
            }
            sidecar::setup_sidecar(app)
        })
        .build(tauri::generate_context!())
        .expect("error while building PaperLens window")
        .run(|app_handle, event| {
            // Two-step exit: try graceful HTTP shutdown first (DESIGN-004),
            // then the Job Object kill as the backstop — closing the job
            // handle cascade-kills whatever survived graceful shutdown.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(info) = app_handle.try_state::<sidecar::BootInfo>() {
                    sidecar::try_graceful_shutdown(&info);
                }
                sidecar::shutdown_sidecar(app_handle);
            }
        });
}