//! Sidecar (paperlens-server) process management: spawn, Job Object
//! attachment, token handshake and exit cleanup.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Sidecar binary name as declared in `bundle.externalBin`.
/// tauri-plugin-shell resolves it flat relative to the app exe dir
/// (`{exe_dir}/paperlens-server.exe`), so the `binaries/` source prefix
/// must NOT be included here.
const SIDECAR_BIN: &str = "paperlens-server";

/// Fixed backend port (see `apps/server/app/core/config.py`, `PAPERLENS_PORT`).
/// Injected explicitly to shield against a system-level PAPERLENS_PORT.
/// Cross-language contract: keep in sync with `DEFAULT_DATA_DIR`
/// (registry.rs), the frontend base URL (`api/client.ts`) and the CSP in
/// `tauri.conf.json`.
const DEFAULT_PORT: &str = "8737";

/// Handshake token file name inside the data directory.
const TOKEN_FILE: &str = ".token";

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

/// Boot contract shared with the exit path: absent when there is no backend
/// to shut down gracefully (spawn failed / token generation failed).
pub(crate) struct BootInfo {
    pub token: String,
    pub port: u16,
    /// Set by the command-event drain task once the sidecar process exits.
    pub terminated: std::sync::Arc<std::sync::atomic::AtomicBool>,
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

pub(crate) fn setup_sidecar(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // (a) Boot handshake token + data directory.
    let data_dir = crate::registry::resolve_data_dir();
    let token = match generate_boot_token() {
        Ok(t) => t,
        Err(e) => {
            // Degrade instead of panicking: without a handshake token the
            // backend cannot be trusted, so continue without it.
            println!("[error] failed to generate boot handshake token: {e}; continuing without backend");
            app.manage(Mutex::new(SidecarGuard { job: 0, child: None }));
            return Ok(());
        }
    };

    // (b) Persist the handshake token BEFORE spawning: the backend reads it on
    // first boot, so writing it after spawn is a startup race.
    let dir = PathBuf::from(&data_dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        println!("[warn] failed to create data dir '{}': {e}", dir.display());
    } else {
        let token_path = dir.join(TOKEN_FILE);
        match std::fs::write(&token_path, token.as_bytes()) {
            Ok(()) => println!("[info] handshake token written to {}", token_path.display()),
            Err(e) => println!("[warn] failed to write handshake token: {e}"),
        }
    }

    // (c) Spawn the sidecar, injecting the handshake env contract.
    // Port is fixed (PAPERLENS_PORT) so the frontend BASE URL can be static.
    let mut command = app
        .shell()
        .sidecar(SIDECAR_BIN)?
        .env("PAPERLENS_BOOT_TOKEN", &token)
        .env("PAPERLENS_DATA_DIR", &data_dir)
        .env("PAPERLENS_PORT", DEFAULT_PORT);

    // (d) Point the backend at bundled read-only resources (install dir).
    // Resource dir layout mirrors `bundle.resources` in tauri.conf.json;
    // absent in dev mode, where scripts/dev.py provides the equivalents.
    // Tauri v2 resource_dir() on Windows may return verbatim \\?\ paths
    // (canonicalized); strip the prefix so consumers (SQLite URI, Popen)
    // receive normal drive paths.
    fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{}", rest))
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            std::path::PathBuf::from(rest)
        } else {
            p
        }
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        let models = strip_verbatim(res_dir.join("resources").join("models"));
        if models.is_dir() {
            command = command.env("PAPERLENS_MODELS_DIR", models);
        }
        let ecdict = strip_verbatim(res_dir.join("resources").join("ecdict.db"));
        if ecdict.is_file() {
            command = command.env("PAPERLENS_ECDICT_PATH", ecdict);
        }
        let ocr = strip_verbatim(
            res_dir
                .join("resources")
                .join("paperlens-ocr")
                .join("paperlens-ocr.exe"),
        );
        if ocr.is_file() {
            command = command.env("PAPERLENS_OCR_EXE", ocr);
        }
    }

    let app_handle = app.handle().clone();
    match command.spawn() {
        Ok((mut rx, child)) => {
            let pid = child.pid();
            println!("[info] sidecar '{SIDECAR_BIN}' spawned (pid {pid})");

            // 退出时序标志：drain 任务在 sidecar 进程退出时置位，
            // try_graceful_shutdown 据此等待优雅退出完成（而非仅 200 响应）。
            let terminated = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            app.manage(crate::sidecar::BootInfo {
                token: token.clone(),
                port: DEFAULT_PORT.parse().unwrap_or(8737),
                terminated: std::sync::Arc::clone(&terminated),
            });

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
                            println!("[error] sidecar error: {e}");
                        }
                        CommandEvent::Terminated(status) => {
                            println!("[info] sidecar terminated: {status:?}");
                            terminated.store(true, std::sync::atomic::Ordering::SeqCst);
                            // Notify the frontend so it can surface a
                            // "backend exited" banner (event name is the
                            // consumer contract; payload is exit code/signal).
                            let _ = app_handle.emit("sidecar-terminated", status);
                        }
                        // CommandEvent is non_exhaustive; ignore future variants.
                        _ => {}
                    }
                }
            });

            // (e) Attach the sidecar to a kill-on-close Job Object.
            let job = create_kill_on_close_job(pid);
            if job == 0 {
                println!("[warn] sidecar is not attached to a Job Object; it may outlive the shell");
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
                "[warn] failed to spawn sidecar '{SIDECAR_BIN}': {e}. \
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
                "[warn] CreateJobObjectW failed (err {})",
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
                "[warn] SetInformationJobObject failed (err {})",
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
                "[warn] OpenProcess(pid {pid}) failed (err {})",
                GetLastError()
            );
            CloseHandle(job);
            return 0;
        }
        if AssignProcessToJobObject(job, process) == 0 {
            println!(
                "[warn] AssignProcessToJobObject failed (err {})",
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

/// Best-effort graceful shutdown: POST /api/shutdown with the boot token,
/// then wait for the sidecar process to actually exit (HTTP 200 only means
/// the exit *started*; lifespan cleanup can take seconds). Any failure
/// (connect refused / non-200 / timeout) returns immediately so the caller
/// falls back to the Job Object kill. Budget: connect 500ms + read 1.5s +
/// exit-poll 5s worst case.
pub(crate) fn try_graceful_shutdown(info: &BootInfo) {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    let Ok(mut stream) = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], info.port)),
        Duration::from_millis(500),
    ) else {
        println!("[info] graceful shutdown: backend not reachable, falling back");
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Boot-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        port = info.port,
        token = info.token,
    );
    if stream.write_all(req.as_bytes()).is_err() {
        println!("[info] graceful shutdown: write failed, falling back");
        return;
    }
    let _ = stream.flush();

    // 读到响应头结束即可；解析状态行，非 200（403/503）不等待
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
                if head.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head_str = String::from_utf8_lossy(&head);
    if !head_str.starts_with("HTTP/1.1 200") && !head_str.starts_with("HTTP/1.0 200") {
        println!("[info] graceful shutdown: non-200 response, falling back");
        return;
    }

    // 等 sidecar 进程真正退出（lifespan 清理完成后 uvicorn 自行结束）
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if info.terminated.load(Ordering::SeqCst) {
            println!("[info] graceful shutdown: backend exited cleanly");
            // 稍候片刻让句柄释放，再由调用方做兜底清理
            std::thread::sleep(Duration::from_millis(200));
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("[warn] graceful shutdown: timed out waiting for backend exit, falling back");
}

/// Exit cleanup: kill the direct child, then close the Job Object handle so
/// any descendant processes (worker processes, etc.) are terminated too.
pub(crate) fn shutdown_sidecar(app_handle: &tauri::AppHandle) {
    let Some(guard) = app_handle.try_state::<Mutex<SidecarGuard>>() else {
        return;
    };
    let Ok(mut g) = guard.lock() else {
        return;
    };

    if let Some(child) = g.child.take() {
        if let Err(e) = child.kill() {
            println!("[warn] failed to kill sidecar: {e}");
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