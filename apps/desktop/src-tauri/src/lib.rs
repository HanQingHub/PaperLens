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
//! - `pending_open`: PDF paths queued from shell launch args (file association)
//! - `assoc`: PDF file association (default opener) registry management
//! - `userchoice`: Windows UserChoice direct write (hash scheme, PS-SFTA-derived)

mod app_icon;
mod assoc;
mod pending_open;
mod proxy;
mod registry;
mod shortcut;
mod sidecar;
mod update_cleanup;
mod updater_check;
mod userchoice;

use std::path::Path;
use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent};

/// Expose the resolved data directory to the settings UI.
#[tauri::command]
fn get_data_dir() -> String {
    registry::resolve_data_dir()
}

/// Open an external link in the system browser (PDF external links).
/// Only http/https (and the system settings page for file-association
/// confirmation) are allowed; tauri-plugin-shell's `open` is deprecated in
/// favor of the opener plugin but kept here to avoid a new plugin dependency.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ms-settings:"))
    {
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
        // 文件关联冷启动：shell 传来的 .pdf 路径先入队（权威数据源），
        // 前端就绪后经 take_pending_pdf_opens 拉取（见 pending_open.rs 模块注释）
        .manage(pending_open::PendingOpens(Mutex::new(
            pending_open::collect_pdf_args(
                std::env::args_os()
                    .skip(1)
                    .map(|s| s.to_string_lossy().into_owned()),
            ),
        )))
        // 单实例必须最先注册（插件约定）：二次启动聚焦既有窗口，
        // 防止第二个实例抢占固定端口 8737 并并发写同一 SQLite 数据目录。
        // 带 .pdf 参数的二次启动（文件关联双击）：路径入队 + 发唤醒事件
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = pending_open::collect_pdf_args(args.iter().map(String::as_str));
            if let Some(state) = app.try_state::<pending_open::PendingOpens>() {
                state.0.lock().unwrap().extend(paths);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.emit("paperlens:open-pdfs", ());
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
            pending_open::take_pending_pdf_opens,
            assoc::get_pdf_assoc_state,
            assoc::set_pdf_assoc,
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
                    // WebView2 pinch 手势恢复：wry 把 IsPinchZoomEnabled 硬绑定到
                    // zoomHotkeysEnabled（默认 false），触摸板/触摸屏捏合手势因此
                    // 在 WebView2 输入层被吞、零事件到页面。此处单独恢复
                    // IsPinchZoomEnabled=true，不启用 zoomHotkeysEnabled——避免连带
                    // 启用 IsZoomControlEnabled（缩放控件 + Ctrl+/-/0，与 app 自身
                    // 缩放快捷键冲突）。捏合恢复后由前端 preventDefault 接管
                    // （touchpad pinch 合成为 wheel(ctrlKey) 事件，走 ReaderPage 现有
                    // setScale 管线），WebView2 的 Page Scale zoom 不触发。
                    let _ = w.with_webview(|webview| unsafe {
                        use windows::core::Interface;
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
                        let Ok(core) = webview.controller().CoreWebView2() else { return };
                        let Ok(settings) = core.Settings() else { return };
                        let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() else { return };
                        let _ = s5.SetIsPinchZoomEnabled(true);
                    });
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