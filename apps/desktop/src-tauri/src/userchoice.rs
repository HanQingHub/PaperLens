//! UserChoice 直写（Win8+ 默认应用哈希体系）。
//!
//! 算法来源：社区逆向的 UserChoice 哈希（PS-SFTA，MIT License，
//! credits: 看雪论坛 thread-213954 / LMongrain PureBasic 版）。
//! 关键流程：整键删除 UserChoice（绕过既有键的 ACL 拒写）→ 重建键写入
//! Hash（先）+ ProgId（后）→ ApplicationAssociationToasts 抑制弹窗 →
//! SHChangeNotify。哈希输入含「本地分钟截断时间」（系统按键 LastWriteTime
//! 的分钟截断重算校验），时间必须经 TzSpecificLocalTimeToSystemTime 转 UTC。

use md5::Md5;
use md5::Digest;

use crate::registry;

#[cfg(windows)]
const USERCHOICE_PREFIX: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts";
#[cfg(windows)]
const TOASTS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\ApplicationAssociationToasts";
#[cfg(windows)]
const UX_SEARCH: &str = "User Choice set via Windows User Experience";
#[cfg(windows)]
const UX_FALLBACK: &str =
    "User Choice set via Windows User Experience {D18B6DD5-6124-4341-9318-804003BAFA0B}";
// userExperience 字符串在 shell32.dll 内的最大搜索范围（与 PS-SFTA 一致取 5MB）
#[cfg(windows)]
const SHELL32_SCAN_LIMIT: u64 = 5 * 1024 * 1024;

/// SFTA Get-Hash 逐行移植：baseInfo（已整串小写）→ 12 字符 base64 Hash。
fn userchoice_hash(base_info: &str) -> String {
    let mut bytes: Vec<u8> = base_info.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    bytes.extend_from_slice(&[0, 0]);
    let md5 = Md5::digest(&bytes);

    let length_base = (base_info.encode_utf16().count() * 2 + 2) as i64;
    let length = (if length_base & 4 <= 1 { 1i64 } else { 0 }) + (length_base >> 2) - 1;
    if length <= 1 {
        return String::new();
    }
    let md = md5.as_slice();
    let g = |b: &[u8], i: usize| i32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as i64;
    // SFTA Get-ShiftRight：i64 域，bit31 置位时算术右移后 XOR 0xFFFF0000。
    // ⚠ PowerShell 字面量 0xFFFF0000 是 Int32 = -65536（符号扩展为
    // 0xFFFFFFFFFFFF0000），不是 +4294901760——负数移位结果是小正数，
    // 误用正掩码会产生巨大中间值导致 i64 溢出（golden 对拍可暴露）。
    let shr = |x: i64, n: u32| if x & 0x80000000 != 0 { (x >> n) ^ -65536i64 } else { x >> n };
    // Convert-Int32：i64 → 截断 i32 → 符号扩展回 i64
    let c32 = |x: i64| -> i64 { (x as i32) as i64 };

    let mut out = [0u8; 16];
    // 两轮各自从 0 起（PS 每轮新建 $map）；首轮的显式初始化值不会被读到
    #[allow(unused_assignments)]
    let mut outhash1: i64 = 0;
    #[allow(unused_assignments)]
    let mut outhash2: i64 = 0;

    // ---- 第一轮（SFTA L630-657）----
    {
        let md51 = (g(md, 0) | 1) + 0x69FB0000;
        let md52 = (g(md, 4) | 1) + 0x13DB0000;
        let mut counter = ((length - 2) >> 1) + 1;
        let mut pdata: usize = 0;
        let mut cache: i64 = 0;
        outhash1 = 0;
        while counter > 0 {
            let r0 = c32(g(&bytes, pdata) + outhash1);
            let r1_0 = c32(g(&bytes, pdata + 4));
            pdata += 8;
            let r2_0 = c32(r0 * md51 - 0x10FA9605 * shr(r0, 16));
            let r2_1 = c32(0x79F8A395 * r2_0 + 0x689B6B9F * shr(r2_0, 16));
            let r3 = c32(0xEA970001 * r2_1 - 0x3C101569 * shr(r2_1, 16));
            let r4_0 = c32(r3 + r1_0);
            let r5_0 = c32(cache + r3);
            let r6_0 = c32(r4_0 * md52 - 0x3CE8EC25 * shr(r4_0, 16));
            let r6_1 = c32(0x59C3AF2D * r6_0 - 0x2232E0F1 * shr(r6_0, 16));
            outhash1 = c32(0x1EC90001 * r6_1 + 0x35BD1EC9 * shr(r6_1, 16));
            outhash2 = c32(r5_0 + outhash1);
            cache = outhash2; // long 语义：int32 符号扩展
            counter -= 1;
        }
        out[0..4].copy_from_slice(&(outhash1 as i32).to_le_bytes());
        out[4..8].copy_from_slice(&(outhash2 as i32).to_le_bytes());
    }

    // ---- 第二轮（SFTA L665-693）----
    {
        let md51 = g(md, 0) | 1;
        let md52 = g(md, 4) | 1;
        let mut counter = ((length - 2) >> 1) + 1;
        let mut pdata: usize = 0;
        let mut cache: i64 = 0;
        outhash1 = 0; // PS 每轮新建 $map：OUTHASH1/OUTHASH2/CACHE 均从 0 起
        outhash2 = 0;
        while counter > 0 {
            let r0 = c32(g(&bytes, pdata) + outhash1);
            pdata += 8;
            let r1_0 = c32(r0 * md51);
            let r1_1 = c32(0xB1110000 * r1_0 - 0x30674EEF * shr(r1_0, 16));
            let r2_0 = c32(0x5B9F0000 * r1_1 - 0x78F7A461 * shr(r1_1, 16));
            let r2_1 = c32(0x12CEB96D * shr(r2_0, 16) - 0x46930000 * r2_0);
            let r3 = c32(0x1D830000 * r2_1 + 0x257E1D83 * shr(r2_1, 16));
            let r4_0 = c32(md52 * (r3 + g(&bytes, pdata - 4)));
            let r4_1 = c32(0x16F50000 * r4_0 - 0x5D8BE90B * shr(r4_0, 16));
            let r5_0 = c32(0x96FF0000 * r4_1 - 0x2C7C6901 * shr(r4_1, 16));
            let r5_1 = c32(0x2B890000 * r5_0 + 0x7C932B89 * shr(r5_0, 16));
            outhash1 = c32(0x9F690000 * r5_1 - 0x405B6097 * shr(r5_1, 16));
            outhash2 = c32(outhash1 + cache + r3);
            cache = outhash2;
            counter -= 1;
        }
        out[8..12].copy_from_slice(&(outhash1 as i32).to_le_bytes());
        out[12..16].copy_from_slice(&(outhash2 as i32).to_le_bytes());
    }

    let g32 = |b: &[u8], i: usize| i32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let hv1 = g32(&out, 8) ^ g32(&out, 0);
    let hv2 = g32(&out, 12) ^ g32(&out, 4);
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode([hv1.to_le_bytes(), hv2.to_le_bytes()].concat())
}

/// 本地时间截断到分钟 → UTC FILETIME（i64，100ns）。
/// ⚠ 必须经 TzSpecificLocalTimeToSystemTime 转换；直接 SystemTimeToFileTime 打包
/// 本地墙钟会多出时区偏移（微软 KB：SystemTimeToFileTime 不做时区转换）。
#[cfg(windows)]
fn get_local_minute_filetime() -> i64 {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    use windows_sys::Win32::System::Time::{SystemTimeToFileTime, TzSpecificLocalTimeToSystemTime};

    unsafe {
        let mut st: SYSTEMTIME = std::mem::zeroed();
        GetLocalTime(&mut st);
        st.wSecond = 0;
        st.wMilliseconds = 0;
        let mut utc: SYSTEMTIME = std::mem::zeroed();
        TzSpecificLocalTimeToSystemTime(std::ptr::null(), &st, &mut utc);
        let mut ft = 0i64;
        SystemTimeToFileTime(&utc, &mut ft as *mut i64 as *mut _);
        ft
    }
}

/// FILETIME → SFTA Get-HexDateTime 形态（hi:X8 + low:X8 小写）。
#[cfg(windows)]
fn get_hex_datetime(ft: i64) -> String {
    let u = ft as u64;
    format!("{:08x}{:08x}", (u >> 32) as u32, (u & 0xFFFF_FFFF) as u32)
}

/// 当前进程用户 SID（小写）。
#[cfg(windows)]
fn get_user_sid() -> Result<String, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) == 0 {
            return Err("OpenProcessToken failed".into());
        }
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
        CloseHandle(token);
        if ok == 0 {
            return Err("GetTokenInformation failed".into());
        }
        let user = buf.as_ptr() as *const TOKEN_USER;
        let mut str_ptr: windows_sys::core::PWSTR = std::ptr::null_mut();
        if ConvertSidToStringSidW((*user).User.Sid, &mut str_ptr) == 0 {
            return Err("ConvertSidToStringSidW failed".into());
        }
        let mut end = str_ptr;
        while *end != 0 {
            end = end.add(1);
        }
        let slice = std::slice::from_raw_parts(str_ptr, end.offset_from(str_ptr) as usize);
        let sid = String::from_utf16_lossy(slice).to_lowercase();
        windows_sys::Win32::Foundation::LocalFree(str_ptr as _);
        Ok(sid)
    }
}

/// 从 shell32.dll 提取 userExperience 字符串（SFTA Get-UserExperience）。
#[cfg(windows)]
fn get_user_experience() -> String {
    for path in [r"C:\Windows\SysWOW64\Shell32.dll", r"C:\Windows\System32\Shell32.dll"] {
        if let Ok(data) = std::fs::read(path) {
            let take = data.len().min(SHELL32_SCAN_LIMIT as usize) & !1;
            let units: Vec<u16> = data[..take]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let s = String::from_utf16_lossy(&units);
            if let Some(p1) = s.find(UX_SEARCH) {
                if let Some(p2rel) = s[p1..].find('}') {
                    return s[p1..=p1 + p2rel].to_string();
                }
            }
        }
    }
    UX_FALLBACK.to_string()
}

/// ApplicationAssociationToasts 标记（SFTA Write-RequiredApplicationAssociationToasts）：
/// 写 "{progid}_{ext}"=0，并批量标记 HKLM 候选（OpenWithProgids/OpenWithList/
/// StartMenuInternet FileAssociations），抑制双击"你要如何打开"提示。
#[cfg(windows)]
fn write_toast_markers(ext: &str, progid: &str) {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;

    // OS 实际格式为 "{ProgId}_{带点扩展名}"（本机注册表 MSEdgePDF_.pdf 等实证）
    let _ = registry::write_registry_dword(
        HKEY_CURRENT_USER,
        TOASTS_KEY,
        &format!("{progid}_{ext}"),
        0,
    );
    let mut candidates: Vec<String> = Vec::new();
    let hk = format!(r"SOFTWARE\Classes\{ext}\OpenWithProgids");
    for name in registry::enum_value_names(HKEY_LOCAL_MACHINE, &hk) {
        if !name.is_empty() {
            candidates.push(format!("{name}_{ext}"));
        }
    }
    let owl = format!(r"SOFTWARE\Classes\{ext}\OpenWithList");
    for sub in registry::enum_subkeys(HKEY_LOCAL_MACHINE, &owl) {
        candidates.push(format!("Applications\\{sub}_{ext}"));
    }
    // StartMenuInternet 覆盖浏览器候选（HKLM + HKCU：per-user 安装的 Chrome 落 HKCU）
    let cap_field = "Capabilities\\FileAssociations";
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for root in ["SOFTWARE", r"SOFTWARE\WOW6432Node"] {
            let smi = format!(r"{root}\Clients\StartMenuInternet");
            for sub in registry::enum_subkeys(hive, &smi) {
                let cap = format!(r"{smi}\{sub}\{cap_field}");
                if let Some(v) = registry::read_registry_string(hive, &cap, ext) {
                    if !v.is_empty() {
                        candidates.push(format!("{v}_{ext}"));
                    }
                }
            }
        }
    }
    for c in candidates {
        let _ = registry::write_registry_dword(HKEY_CURRENT_USER, TOASTS_KEY, &c, 0);
    }
}

/// 删除并重建 UserChoice 键，写入带合法哈希的默认关联。
/// 运行时失败信号 = 各 API 错误码（不做任何阻塞等待）。
#[cfg(windows)]
pub(crate) fn write_user_choice(ext: &str, progid: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;

    let key = format!("{USERCHOICE_PREFIX}\\{ext}\\UserChoice");
    for attempt in 0..2 {
        // 受 ACL 保护键上 RegDeleteTreeW 会被静默拒绝——必须用 SFTA 同款
        // RegDeleteKeyW。键不存在（ERROR_FILE_NOT_FOUND=2）视为已删除继续写
        // （SFTA "Remove If Exist" 语义）；其余错误码显式报错
        if let Err(code) = registry::delete_registry_key(HKEY_CURRENT_USER, &key) {
            if code != 2 {
                return Err(format!("UserChoice delete failed: code {code}"));
            }
        }
        let sid = get_user_sid()?;
        let ft = get_local_minute_filetime();
        let ux = get_user_experience();
        let base_info = format!("{ext}{sid}{progid}{}{ux}", get_hex_datetime(ft)).to_lowercase();
        let hash = userchoice_hash(&base_info);
        registry::write_registry_string(HKEY_CURRENT_USER, &key, "Hash", &hash)?;
        registry::write_registry_string(HKEY_CURRENT_USER, &key, "ProgId", progid)?;
        // 跨分钟自检：键 LastWriteTime 必须落在与 ft 相同的本地分钟内，
        // 否则系统按 LastWriteTime 重算校验会失败 → 重算重写一次
        if let Some(lwt) = registry::query_last_write_filetime(HKEY_CURRENT_USER, &key) {
            let minute = 60_000_0000i64;
            let delta = lwt - ft;
            if (0..minute).contains(&delta) || attempt == 1 {
                write_toast_markers(ext, progid);
                return Ok(());
            }
        } else {
            write_toast_markers(ext, progid);
            return Ok(());
        }
    }
    unreachable!()
}

#[cfg(not(windows))]
pub(crate) fn write_user_choice(_ext: &str, _progid: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::userchoice_hash;

    const SID: &str = "s-1-5-21-1273331842-553249899-393495834-1001";
    const UX: &str =
        "user choice set via windows user experience {d18b6dd5-6124-4341-9318-804003bafa0b}";

    /// golden #1：注册表 oracle（PS-SFTA 写入后本机 UserChoice 存储值，
    /// 审核员 Python 复刻 + Rust 双实现对拍三重验证）
    #[test]
    fn golden_anchor_matches_registry_value() {
        let base = format!(".pdf{SID}msedgepdf01dceb659ea35200{UX}");
        assert_eq!(userchoice_hash(&base), "MedZS2nlXkw=");
    }

    /// golden #2/#3：Python 复刻产出的派生向量（覆盖同一长度对齐下的输入微扰）
    #[test]
    fn golden_derived_vectors() {
        let base_a = format!(".pdf{SID}paperlens.pdf01dceb659ea35200{UX}");
        assert_eq!(userchoice_hash(&base_a), "0ArWD9QWT9Q=");
        let base_b = format!(".pdf{SID}paperlens.pdf01dceb659ea35201{UX}");
        assert_eq!(userchoice_hash(&base_b), "AU0VQLp9KcA=");
    }
}
