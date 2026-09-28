//! Force the main window to the foreground on single-instance wake.
//!
//! Windows' foreground lock denies `SetForegroundWindow` from background
//! processes (the window only flashes in the taskbar), which is exactly the
//! state of the first instance when a second launch arrives from a shell
//! double-click. Temporarily attaching the calling thread to the foreground
//! thread's input queue grants foreground permission (the standard
//! Electron/Tauri remedy). The single-instance callback runs on the first
//! instance's main thread, so `GetCurrentThreadId()` is the main window
//! thread and the attach is well-formed.

#[cfg(windows)]
pub(crate) fn force_foreground(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        // Attach to the foreground thread's input queue so SetForegroundWindow
        // is permitted; without this the call is rejected (taskbar flash only).
        let fg = GetForegroundWindow();
        let fg_thread = if fg != HWND::default() {
            GetWindowThreadProcessId(fg, None)
        } else {
            0
        };
        let cur = GetCurrentThreadId();
        let attached =
            fg_thread != 0 && fg_thread != cur && AttachThreadInput(cur, fg_thread, true).as_bool();
        // Restore first: SetForegroundWindow is a no-op on a minimized window.
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(cur, fg_thread, false);
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn force_foreground(_window: &tauri::WebviewWindow) {}
