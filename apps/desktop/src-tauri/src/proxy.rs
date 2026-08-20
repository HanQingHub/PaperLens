//! Windows system-proxy injection for the updater's HTTP client.

/// Inject the Windows system proxy (WinINET registry, where clash/v2ray etc.
/// write their "system proxy" toggle) into this process's environment, so the
/// updater plugin's reqwest client (which reads HTTPS_PROXY/HTTP_PROXY first,
/// see hyper-util Matcher::from_system) routes update traffic through it.
/// No proxy enabled → leave env untouched (reqwest falls back to direct).
/// Runs in `run()` before the sidecar is spawned, so the backend inherits the
/// same proxy env plus `NO_PROXY` (127.0.0.1,localhost) for its local traffic.
#[cfg(windows)]
pub(crate) fn inject_system_proxy() {
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };

    const INET_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let subkey: Vec<u16> = INET_KEY.encode_utf16().chain(std::iter::once(0)).collect();
    let enable_name: Vec<u16> = "ProxyEnable".encode_utf16().chain(std::iter::once(0)).collect();

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

        let server = crate::registry::read_registry_string(HKEY_CURRENT_USER, INET_KEY, "ProxyServer");
        RegCloseKey(hkey);

        if !enable_ok || enabled == 0 {
            return;
        }
        let Some(server) = server else { return };
        if server.is_empty() {
            return;
        }
        let (http, https) = split_proxy_urls(&server);
        apply_proxy_env(http, https);
    }
}

/// Parse the `ProxyServer` registry value: "host:port" applies to both
/// schemes; per-scheme "http=host1:port;https=host2:port" splits them.
/// https requests fall back to the http proxy when no https one is set.
#[cfg(windows)]
fn split_proxy_urls(server: &str) -> (Option<String>, Option<String>) {
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
    let https = https.or_else(|| http.clone());
    (http, https)
}

/// Set the proxy env for this process (inherited by the sidecar at spawn).
/// The backend must never route its local 127.0.0.1 traffic through the
/// proxy, so `NO_PROXY` is set alongside HTTP(S)_PROXY.
#[cfg(windows)]
fn apply_proxy_env(http: Option<String>, https: Option<String>) {
    if http.is_none() && https.is_none() {
        return;
    }
    if let Some(url) = http {
        std::env::set_var("HTTP_PROXY", &url);
    }
    if let Some(url) = https {
        std::env::set_var("HTTPS_PROXY", url);
    }
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
}

#[cfg(all(windows, test))]
mod tests {
    use super::*;

    #[test]
    fn plain_server_applies_to_both_schemes() {
        let (http, https) = split_proxy_urls("127.0.0.1:7897");
        assert_eq!(http.as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(https.as_deref(), Some("http://127.0.0.1:7897"));
    }

    #[test]
    fn per_scheme_servers_are_split() {
        let (http, https) = split_proxy_urls("http=host1:8080;https=host2:8443");
        assert_eq!(http.as_deref(), Some("host1:8080"));
        assert_eq!(https.as_deref(), Some("host2:8443"));
    }

    #[test]
    fn https_falls_back_to_http_proxy() {
        let (_, https) = split_proxy_urls("http=host1:8080");
        assert_eq!(https.as_deref(), Some("host1:8080"));
    }

    // Mutates process env (HTTP_PROXY/HTTPS_PROXY/NO_PROXY): must run
    // serially with any other env-mutating test (no #[serial] dependency,
    // so this is the only test in the crate that touches these vars).
    #[test]
    fn apply_proxy_env_sets_no_proxy_only_when_proxy_enabled() {
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("NO_PROXY");

        apply_proxy_env(None, None);
        assert_eq!(std::env::var_os("NO_PROXY"), None);

        apply_proxy_env(Some("http://p:1".into()), None);
        assert_eq!(std::env::var("HTTP_PROXY").as_deref(), Ok("http://p:1"));
        assert_eq!(std::env::var_os("HTTPS_PROXY"), None);
        assert_eq!(std::env::var("NO_PROXY").as_deref(), Ok("127.0.0.1,localhost"));

        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("NO_PROXY");
    }
}
