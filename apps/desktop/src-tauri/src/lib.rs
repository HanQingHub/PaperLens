//! PaperLens desktop shell (Tauri v2 thin shell).
//!
//! Responsibilities:
//! - Spawn the `paperlens-server` sidecar with a boot handshake token and the data dir.
//! - Attach the sidecar to a Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
//!   so the entire sidecar process tree dies when the shell exits
//!   (tauri-plugin-shell's `kill` only terminates the direct child).
//! - Write the handshake token to `{data dir}\.token` for the sidecar to pick up.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Sidecar binary name as declared in `bundle.externalBin`.
/// tauri-plugin-shell resolves it flat relative to the app exe dir
/// (`{exe_dir}/paperlens-server.exe`), so the `binaries/` source prefix
/// must NOT be included here.
const SIDECAR_BIN: &str = "paperlens-server";

/// Default data directory, consistent with the backend configuration.
/// Can be overridden with the `PAPERLENS_DATA_DIR` environment variable.
const DEFAULT_DATA_DIR: &str = r"D:\PaperLens";

/// Fixed backend port (see `scripts/server_entry.py`, `PAPERLENS_PORT`).
/// Injected explicitly to shield against a system-level PAPERLENS_PORT.
const DEFAULT_PORT: &str = "8737";

/// Handshake token file name inside the data directory.
const TOKEN_FILE: &str = ".token";

/// Resolve the data directory, mirroring the backend fallback in
/// `apps/server/app/core/config.py`: explicit env wins; otherwise
/// `D:\PaperLens` when the D: drive exists, else `%LOCALAPPDATA%\PaperLens`.
fn resolve_data_dir() -> String {
    if let Ok(d) = std::env::var("PAPERLENS_DATA_DIR") {
        if !d.is_empty() {
            return d;
        }
    }
    if Path::new("D:\\").is_dir() {
        DEFAULT_DATA_DIR.to_string()
    } else {
        PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
            .join("PaperLens")
            .to_string_lossy()
            .into_owned()
    }
}

/// Managed app state guarding the sidecar lifetime.
///
/// The Job Object handle is stored as `isize` (not `HANDLE`) so the struct
/// stays `Send + Sync`. Keeping the handle alive here prevents it from being
/// closed early (which would kill the job's processes prematurely); it is
/// closed explicitly on exit, cascading termination through the process tree.
struct SidecarGuard {
    /// Windows Job Object handle (`0` when unavailable / non-Windows).
    job: isize,
    /// The spawned sidecar child process, if any.
    child: Option<CommandChild>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    inject_system_proxy();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![startup_check])
        .setup(setup_sidecar)
        .build(tauri::generate_context!())
        .expect("error while building PaperLens window")
        .run(|app_handle, event| {
            // Two-step exit policy: the graceful HTTP shutdown step
            // is skipped because the backend has no shutdown endpoint; closing
            // the Job Object handle cascade-kills the whole sidecar tree.
            if let RunEvent::ExitRequested { .. } = event {
                shutdown_sidecar(app_handle);
            }
        });
}

/// Generate the 32-byte boot handshake token as 64 hex chars (CSPRNG-backed).
fn generate_boot_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)?;
    Ok(bytes.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    }))
}

fn setup_sidecar(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // (a) Boot handshake token + data directory.
    let data_dir = resolve_data_dir();
    let token = generate_boot_token().expect("failed to generate boot handshake token");

    // (b) Spawn the sidecar, injecting the handshake env contract.
    // Port is fixed (PAPERLENS_PORT) so the frontend BASE URL can be static.
    let mut command = app
        .shell()
        .sidecar(SIDECAR_BIN)?
        .env("PAPERLENS_BOOT_TOKEN", &token)
        .env("PAPERLENS_DATA_DIR", &data_dir)
        .env("PAPERLENS_PORT", DEFAULT_PORT);

    // (c) Point the backend at bundled read-only resources (install dir).
    // Resource dir layout mirrors `bundle.resources` in tauri.conf.json;
    // absent in dev mode, where scripts/dev.py provides the equivalents.
    if let Ok(res_dir) = app.path().resource_dir() {
        let models = res_dir.join("resources").join("models");
        if models.is_dir() {
            command = command.env("PAPERLENS_MODELS_DIR", models);
        }
        let ecdict = res_dir.join("resources").join("ecdict.db");
        if ecdict.is_file() {
            command = command.env("PAPERLENS_ECDICT_PATH", ecdict);
        }
        let ocr = res_dir
            .join("resources")
            .join("paperlens-ocr")
            .join("paperlens-ocr.exe");
        if ocr.is_file() {
            command = command.env("PAPERLENS_OCR_EXE", ocr);
        }
    }

    match command.spawn() {
        Ok((mut rx, child)) => {
            let pid = child.pid();
            println!("[PaperLens] sidecar '{SIDECAR_BIN}' spawned (pid {pid})");

            // Drain the command-event channel (bounded, capacity 1): without a
            // consumer the sidecar's stdout/stderr pipes would fill up and
            // block the backend. Forward output to the shell console.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            println!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(e) => {
                            println!("[PaperLens] sidecar error: {e}");
                        }
                        CommandEvent::Terminated(status) => {
                            println!("[PaperLens] sidecar terminated: {status:?}");
                        }
                        // CommandEvent is non_exhaustive; ignore future variants.
                        _ => {}
                    }
                }
            });

            // (c) Attach the sidecar to a kill-on-close Job Object.
            let job = create_kill_on_close_job(pid);
            if job == 0 {
                println!("[PaperLens] WARN: sidecar is not attached to a Job Object; it may outlive the shell");
            }

            // (d) Persist the handshake token for the sidecar to pick up.
            let dir = PathBuf::from(&data_dir);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                println!(
                    "[PaperLens] WARN: failed to create data dir '{}': {e}",
                    dir.display()
                );
            } else {
                let token_path = dir.join(TOKEN_FILE);
                match std::fs::write(&token_path, token.as_bytes()) {
                    Ok(()) => {
                        println!("[PaperLens] handshake token written to {}", token_path.display())
                    }
                    Err(e) => println!("[PaperLens] WARN: failed to write handshake token: {e}"),
                }
            }

            app.manage(Mutex::new(SidecarGuard {
                job,
                child: Some(child),
            }));
        }
        // Development convenience: the sidecar exe may not exist yet. Do not
        // panic; the frontend can still load and show a connection error.
        Err(e) => {
            println!(
                "[PaperLens] WARN: failed to spawn sidecar '{SIDECAR_BIN}': {e}. \
                 Continuing without backend (expected while the sidecar binary is absent)."
            );
            app.manage(Mutex::new(SidecarGuard { job: 0, child: None }));
        }
    }

    Ok(())
}

/// Create an anonymous Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
/// and assign the given process to it.
///
/// Returns the job handle as `isize`, or `0` on failure. Windows 8+ allows
/// nested jobs, so this works even if the sidecar was already inside a job.
#[cfg(windows)]
fn create_kill_on_close_job(pid: u32) -> isize {
    use std::mem;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    unsafe {
        // 1) Anonymous job object.
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            println!(
                "[PaperLens] WARN: CreateJobObjectW failed (err {})",
                GetLastError()
            );
            return 0;
        }

        // 2) Killing the last job handle terminates every process in the job.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            println!(
                "[PaperLens] WARN: SetInformationJobObject failed (err {})",
                GetLastError()
            );
            CloseHandle(job);
            return 0;
        }

        // 3) Open the sidecar process and assign it to the job.
        //    PROCESS_SET_QUOTA is required for AssignProcessToJobObject.
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            println!(
                "[PaperLens] WARN: OpenProcess(pid {pid}) failed (err {})",
                GetLastError()
            );
            CloseHandle(job);
            return 0;
        }
        if AssignProcessToJobObject(job, process) == 0 {
            println!(
                "[PaperLens] WARN: AssignProcessToJobObject failed (err {})",
                GetLastError()
            );
            CloseHandle(process);
            CloseHandle(job);
            return 0;
        }
        CloseHandle(process);

        job as isize
    }
}

#[cfg(not(windows))]
fn create_kill_on_close_job(_pid: u32) -> isize {
    // PaperLens targets Windows only; other platforms keep the direct-child kill path.
    0
}

/// Exit cleanup: kill the direct child, then close the Job Object handle so
/// any descendant processes (worker processes, etc.) are terminated too.
fn shutdown_sidecar(app_handle: &tauri::AppHandle) {
    let Some(guard) = app_handle.try_state::<Mutex<SidecarGuard>>() else {
        return;
    };
    let Ok(mut g) = guard.lock() else {
        return;
    };

    if let Some(child) = g.child.take() {
        if let Err(e) = child.kill() {
            println!("[PaperLens] WARN: failed to kill sidecar: {e}");
        }
    }

    #[cfg(windows)]
    if g.job != 0 {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(g.job as _);
        }
        g.job = 0;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Auto-update: startup self-check (design doc P1-6 + resources integrity).
// The updater plugin itself does not verify that a silent install succeeded,
// so on boot we compare the NSIS-registered version with the running app and
// verify the bundled resources survived the update (they must be preserved by
// the resources-free update package).
// ────────────────────────────────────────────────────────────────────────────

/// Result of the startup self-check, consumed by the frontend updater module.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupCheck {
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
fn startup_check(app: tauri::AppHandle) -> StartupCheck {
    let app_version = app.package_info().version.to_string();

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

/// Read `DisplayVersion` from the currentUser uninstall registry key written
/// by our NSIS template (installMode=currentUser → SHCTX = HKCU).
#[cfg(windows)]
fn read_installed_version() -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
    };

    const UNINST_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperLens";
    let subkey: Vec<u16> = UNINST_KEY.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = "DisplayVersion".encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // windows-sys 0.59: HKEY is a raw pointer (`*mut c_void`), not an integer.
        let mut hkey: HKEY = std::ptr::null_mut();
        let opened: WIN32_ERROR =
            RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey);
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

/// Inject the Windows system proxy (WinINET registry, where clash/v2ray etc.
/// write their "system proxy" toggle) into this process's environment, so the
/// updater plugin's reqwest client (which reads HTTPS_PROXY/HTTP_PROXY first,
/// see hyper-util Matcher::from_system) routes update traffic through it.
/// No proxy enabled → leave env untouched (reqwest falls back to direct).
#[cfg(windows)]
fn inject_system_proxy() {
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
        REG_SZ,
    };

    const INET_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let subkey: Vec<u16> = INET_KEY.encode_utf16().chain(std::iter::once(0)).collect();
    let enable_name: Vec<u16> = "ProxyEnable".encode_utf16().chain(std::iter::once(0)).collect();
    let server_name: Vec<u16> = "ProxyServer".encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let opened: WIN32_ERROR =
            RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey);
        if opened != ERROR_SUCCESS {
            return;
        }

        let mut enabled = 0u32;
        let mut ty = 0u32;
        let mut len = std::mem::size_of::<u32>() as u32;
        let enable_ok = RegQueryValueExW(
            hkey,
            enable_name.as_ptr(),
            std::ptr::null(),
            &mut ty,
            &mut enabled as *mut u32 as *mut u8,
            &mut len,
        ) == ERROR_SUCCESS
            && ty == REG_DWORD;

        let mut server = None;
        let mut ty = 0u32;
        let mut len = 0u32;
        if RegQueryValueExW(
            hkey,
            server_name.as_ptr(),
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
                server_name.as_ptr(),
                std::ptr::null(),
                &mut ty,
                buf.as_mut_ptr() as *mut u8,
                &mut len,
            ) == ERROR_SUCCESS
            {
                server = Some(String::from_utf16_lossy(&buf[..len as usize / 2]));
            }
        }
        RegCloseKey(hkey);

        let Some(server) = server.map(|s| s.trim_end_matches('\0').to_string()) else {
            return;
        };
        if !enable_ok || enabled == 0 || server.is_empty() {
            return;
        }

        // ProxyServer formats: "host:port" or per-scheme "http=host1:port;https=host2:port".
        let mut http = None;
        let mut https = None;
        if server.contains('=') {
            for part in server.split(';') {
                let mut kv = part.splitn(2, '=');
                if let (Some(k), Some(v)) = (kv.next(), kv.next()) {
                    let v = v.trim().to_string();
                    match k.trim().to_ascii_lowercase().as_str() {
                        "http" => http = Some(v),
                        "https" => https = Some(v),
                        _ => {}
                    }
                }
            }
        } else {
            let plain = format!("http://{server}");
            http = Some(plain.clone());
            https = Some(plain);
        }
        // https requests fall back to the http proxy if no https one is set.
        let https = https.or_else(|| http.clone());
        if let Some(url) = http {
            std::env::set_var("HTTP_PROXY", &url);
        }
        if let Some(url) = https {
            std::env::set_var("HTTPS_PROXY", url);
        }
    }
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
