//! Stale updater package cleanup: removes `%TEMP%\PaperLens-<version>-updater-<rand>`
//! directories left behind by tauri-plugin-updater after install.
//!
//! Safety guards (all must hold before deleting):
//! - directory name matches `PaperLens-*-updater-*`
//! - the directory contains an `*-installer.exe` file (update package signature;
//!   download-interrupted directories never match and are left alone by design)
//! - directory mtime is at least 24h old (download/install runs take minutes,
//!   so a fresh mtime means the updater may still be using it)
//!
//! Failures are logged and skipped; cleanup never blocks or fails app startup.

use std::path::Path;
use std::time::SystemTime;

/// Minimum age (in seconds) before a leftover updater directory may be deleted.
const STALE_AFTER_SECS: u64 = 24 * 3600;

/// Remove stale updater temp directories under the system temp dir.
/// Returns the number of directories removed.
pub fn cleanup_stale_update_installers(now: SystemTime) -> usize {
    cleanup_stale_update_installers_in(&std::env::temp_dir(), now)
}

/// Directory-scoped variant (unit-testable without touching real leftovers).
fn cleanup_stale_update_installers_in(root: &Path, now: SystemTime) -> usize {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            println!("[warn] update cleanup: cannot read temp dir '{}': {e}", root.display());
            return 0;
        }
    };

    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_updater_dir_name(name) {
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        if !contains_installer_exe(&path) {
            continue;
        }
        match entry.metadata().and_then(|m| m.modified()) {
            Ok(mtime) => {
                let age = now.duration_since(mtime).map(|d| d.as_secs()).unwrap_or(0);
                if age < STALE_AFTER_SECS {
                    continue;
                }
            }
            Err(e) => {
                println!("[warn] update cleanup: cannot stat '{}': {e}", path.display());
                continue;
            }
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            Err(e) => println!("[warn] update cleanup: failed to remove '{}': {e}", path.display()),
        }
    }

    if removed > 0 {
        println!("[PaperLens] removed {removed} stale updater temp dir(s)");
    }
    removed
}

/// `PaperLens-*-updater-*` name pattern (case matters: the updater uses the
/// configured product name verbatim).
fn is_updater_dir_name(name: &str) -> bool {
    name.starts_with("PaperLens-") && name.contains("-updater-")
}

/// The update package signature file: `*-installer.exe` directly inside the dir.
fn contains_installer_exe(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path().is_file()
            && e.file_name().to_string_lossy().ends_with("-installer.exe")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// Unique scratch dir (parallel-test safe) that removes itself on drop.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "pl-cleanup-test-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).expect("create scratch dir");
            Scratch(dir)
        }

        fn updater_dir(&self, name: &str) -> std::path::PathBuf {
            let d = self.0.join(name);
            std::fs::create_dir_all(&d).expect("create updater dir");
            d
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &std::path::PathBuf) {
        std::fs::write(path, b"stub").expect("write file");
    }

    fn set_mtime(path: &std::path::PathBuf, t: SystemTime) {
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(t))
            .expect("set mtime");
    }

    #[test]
    fn deletes_stale_dir_with_installer() {
        let s = Scratch::new();
        let d = s.updater_dir("PaperLens-0.2.5-updater-abc123");
        touch(&d.join("PaperLens-0.2.5-installer.exe"));
        set_mtime(&d, SystemTime::now() - Duration::from_secs(48 * 3600));

        let now = SystemTime::now();
        assert_eq!(cleanup_stale_update_installers_in(&s.0, now), 1);
        assert!(!d.exists());
    }

    #[test]
    fn keeps_recent_dir() {
        let s = Scratch::new();
        let d = s.updater_dir("PaperLens-0.2.6-updater-xyz789");
        touch(&d.join("PaperLens-0.2.6-installer.exe"));
        set_mtime(&d, SystemTime::now() - Duration::from_secs(60));

        let now = SystemTime::now();
        assert_eq!(cleanup_stale_update_installers_in(&s.0, now), 0);
        assert!(d.exists());
    }

    #[test]
    fn keeps_matching_name_without_installer() {
        let s = Scratch::new();
        let d = s.updater_dir("PaperLens-0.2.5-updater-interrupted");
        touch(&d.join("partial-download.bin"));
        set_mtime(&d, SystemTime::now() - Duration::from_secs(72 * 3600));

        let now = SystemTime::now();
        assert_eq!(cleanup_stale_update_installers_in(&s.0, now), 0);
        assert!(d.exists());
    }

    #[test]
    fn keeps_unrelated_names_and_files() {
        let s = Scratch::new();
        // Name pattern not matching (other app) → kept even with installer + old mtime.
        let d = s.updater_dir("some-other-app-updater-123456");
        touch(&d.join("x-installer.exe"));
        set_mtime(&d, SystemTime::now() - Duration::from_secs(72 * 3600));
        // Matching name but a plain file, not a dir → ignored without error.
        let f = s.0.join("PaperLens-0.2.5-updater-notadir");
        touch(&f);

        let now = SystemTime::now();
        assert_eq!(cleanup_stale_update_installers_in(&s.0, now), 0);
        assert!(d.exists());
        assert!(f.exists());
    }

    #[test]
    fn keeps_boundary_at_exactly_24h() {
        let s = Scratch::new();
        let d = s.updater_dir("PaperLens-0.2.4-updater-boundary");
        touch(&d.join("PaperLens-0.2.4-installer.exe"));
        let now = SystemTime::now();
        set_mtime(&d, now - Duration::from_secs(STALE_AFTER_SECS));

        assert_eq!(cleanup_stale_update_installers_in(&s.0, now), 1);
        assert!(!d.exists());
    }
}
