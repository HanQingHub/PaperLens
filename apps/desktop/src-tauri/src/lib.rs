//! PaperLens desktop shell (Tauri v2 thin shell).
//!
//! Responsibilities (per docs/软件需求与架构文档.md §6.5):
//! - Spawn the `paperlens-server` sidecar with a boot handshake token and the data dir.
//! - Attach the sidecar to a Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
//!   so the entire sidecar process tree dies when the shell exits
//!   (tauri-plugin-shell's `kill` only terminates the direct child).
//! - Write the handshake token to `{data dir}\.token` for the sidecar to pick up.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Sidecar binary name as declared in `bundle.externalBin`.
/// Tauri resolves it with the target-triple suffix at runtime
/// (e.g. `binaries/paperlens-server-x86_64-pc-windows-msvc.exe`).
const SIDECAR_BIN: &str = "binaries/paperlens-server";

/// Default data directory, consistent with the backend configuration.
/// Can be overridden with the `PAPERLENS_DATA_DIR` environment variable.
const DEFAULT_DATA_DIR: &str = r"D:\PaperLens";

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(setup_sidecar)
        .build(tauri::generate_context!())
        .expect("error while building PaperLens window")
        .run(|app_handle, event| {
            // Two-step exit policy (docs §6.5): the graceful HTTP shutdown step
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
    let data_dir =
        std::env::var("PAPERLENS_DATA_DIR").unwrap_or_else(|_| DEFAULT_DATA_DIR.to_string());
    let token = generate_boot_token().expect("failed to generate boot handshake token");

    // (b) Spawn the sidecar, injecting the handshake env contract.
    // The backend chooses its own random port on 127.0.0.1, so no `--port` is passed.
    let command = app
        .shell()
        .sidecar(SIDECAR_BIN)?
        .env("PAPERLENS_BOOT_TOKEN", &token)
        .env("PAPERLENS_DATA_DIR", &data_dir);

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
