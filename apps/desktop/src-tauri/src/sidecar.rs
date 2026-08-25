//! Sidecar (paperlens-server) process management: spawn, Job Object
//! attachment, token handshake and exit cleanup.
//!
//! The server ships as a PyInstaller **onedir** directory under
//! `resources/paperlens-server/` (bundled via `bundle.resources`, same
//! mechanism as the OCR worker) — onefile self-extraction cost ~1.3s per
//! launch and is the single largest startup regression. Spawning therefore
//! goes through a plain `std::process::Command` resolved from the resource
//! dir instead of tauri-plugin-shell's flat `externalBin` sidecar channel.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

/// Server exe path relative to the resource dir (`resources/paperlens-server/`).
/// Mirrors the `bundle.resources` mapping in tauri.conf.json.
const SERVER_RESOURCE_EXE: &str = "resources/paperlens-server/paperlens-server.exe";

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
/// The child handle itself lives in the wait thread; the guard keeps only the
/// pid for a fast-path terminate before the Job Object backstop closes.
struct SidecarGuard {
    /// Windows Job Object handle (`0` when unavailable / non-Windows).
    job: isize,
    /// The spawned sidecar pid, if any.
    pid: Option<u32>,
}

/// Boot contract shared with the exit path: absent when there is no backend
/// to shut down gracefully (spawn failed / token generation failed).
pub(crate) struct BootInfo {
    pub token: String,
    pub port: u16,
    /// Set by the wait thread once the sidecar process exits.
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
            app.manage(Mutex::new(SidecarGuard { job: 0, pid: None }));
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

    // (c) Resolve the onedir server from the resource dir and spawn it with
    // the handshake env contract. Port is fixed (PAPERLENS_PORT) so the
    // frontend BASE URL can be static. The resource dir is absent in dev
    // mode (scripts/dev.py provides the backend there) — spawn failure then
    // degrades to "continue without backend" exactly like a missing sidecar.
    let server_exe = app
        .path()
        .resource_dir()
        .map(|res| strip_resource_prefix(res).join(SERVER_RESOURCE_EXE))
        .ok();

    let Some(server_exe) = server_exe.filter(|p| p.is_file()) else {
        println!(
            "[warn] server not found at resource path '{SERVER_RESOURCE_EXE}'; \
             continuing without backend (expected in dev mode)"
        );
        app.manage(Mutex::new(SidecarGuard { job: 0, pid: None }));
        return Ok(());
    };

    // Tauri v2 resource_dir() on Windows may return verbatim \\?\ paths
    // (canonicalized); strip the prefix so consumers (SQLite URI, Popen)
    // receive normal drive paths.
    fn strip_resource_prefix(p: std::path::PathBuf) -> std::path::PathBuf {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{}", rest))
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            std::path::PathBuf::from(rest)
        } else {
            p
        }
    }

    let mut command = std::process::Command::new(&server_exe);
    command
        .env("PAPERLENS_BOOT_TOKEN", &token)
        .env("PAPERLENS_DATA_DIR", &data_dir)
        .env("PAPERLENS_PORT", DEFAULT_PORT)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // (d) Point the backend at bundled read-only resources (install dir).
    // Resource dir layout mirrors `bundle.resources` in tauri.conf.json.
    if let Ok(res_dir) = app.path().resource_dir() {
        let res_dir = strip_resource_prefix(res_dir);
        let models = res_dir.join("resources").join("models");
        if models.is_dir() {
            command.env("PAPERLENS_MODELS_DIR", models);
        }
        let ecdict = res_dir.join("resources").join("ecdict.db");
        if ecdict.is_file() {
            command.env("PAPERLENS_ECDICT_PATH", ecdict);
        }
        let ocr = res_dir
            .join("resources")
            .join("paperlens-ocr")
            .join("paperlens-ocr.exe");
        if ocr.is_file() {
            command.env("PAPERLENS_OCR_EXE", ocr);
        }
    }

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: the onedir exe is a console subsystem binary
        // (PyInstaller bootloader); without this flag a console window
        // flashes on every launch.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let app_handle = app.handle().clone();
    match command.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            println!(
                "[info] server '{}' spawned (pid {pid})",
                server_exe.display()
            );

            // 退出时序标志：wait 线程在 server 进程退出时置位，
            // try_graceful_shutdown 据此等待优雅退出完成（而非仅 200 响应）。
            let terminated = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            app.manage(crate::sidecar::BootInfo {
                token: token.clone(),
                port: DEFAULT_PORT.parse().unwrap_or(8737),
                terminated: std::sync::Arc::clone(&terminated),
            });

            // Drain stdout/stderr on dedicated threads: unread pipes fill up
            // and block the backend. Forward output to the shell console.
            // The child handle moves into the wait thread; the guard keeps
            // only the pid (Job Object close is the real terminator).
            if let Some(stdout) = child.stdout.take() {
                std::thread::spawn(move || {
                    drain_pipe(stdout, "[sidecar]");
                });
            }
            if let Some(stderr) = child.stderr.take() {
                std::thread::spawn(move || {
                    drain_pipe(stderr, "[sidecar:err]");
                });
            }
            let wait_handle = app_handle.clone();
            let wait_terminated = std::sync::Arc::clone(&terminated);
            std::thread::spawn(move || {
                let status = child.wait();
                println!("[info] server exited: {status:?}");
                wait_terminated.store(true, std::sync::atomic::Ordering::SeqCst);
                // Notify the frontend so it can surface a
                // "backend exited" banner (event name is the
                // consumer contract; payload is exit code/signal).
                let _ = wait_handle.emit(
                    "sidecar-terminated",
                    status.map(|s| s.code()).unwrap_or(None),
                );
            });

            // (e) Attach the sidecar to a kill-on-close Job Object.
            let job = create_kill_on_close_job(pid);
            if job == 0 {
                println!("[warn] sidecar is not attached to a Job Object; it may outlive the shell");
            }

            app.manage(Mutex::new(SidecarGuard { job, pid: Some(pid) }));
        }
        Err(e) => {
            println!(
                "[warn] failed to spawn server '{}': {e}. \
                 Continuing without backend.",
                server_exe.display()
            );
            app.manage(Mutex::new(SidecarGuard { job: 0, pid: None }));
        }
    }

    Ok(())
}

/// Forward a child pipe to the shell console until EOF.
fn drain_pipe(pipe: impl std::io::Read, prefix: &str) {
    use std::io::BufRead;
    let reader = std::io::BufReader::new(pipe);
    for line in reader.lines() {
        match line {
            Ok(l) => println!("{prefix} {l}"),
            Err(_) => break,
        }
    }
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

/// Exit cleanup: terminate the direct child (fast path), then close the
/// Job Object handle so any descendant processes (worker processes, etc.)
/// are terminated too.
pub(crate) fn shutdown_sidecar(app_handle: &tauri::AppHandle) {
    let Some(guard) = app_handle.try_state::<Mutex<SidecarGuard>>() else {
        return;
    };
    let Ok(mut g) = guard.lock() else {
        return;
    };

    if let Some(pid) = g.pid.take() {
        #[cfg(windows)]
        terminate_pid(pid);
    }

    #[cfg(windows)]
    if g.job != 0 {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(g.job as _);
        }
        g.job = 0;
    }
}

/// Best-effort terminate by pid; the Job Object close right after is the
/// authoritative backstop (this only makes the direct child exit faster so
/// uvicorn's port is released before the window teardown completes).
#[cfg(windows)]
fn terminate_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 0);
            CloseHandle(handle);
        }
    }
}