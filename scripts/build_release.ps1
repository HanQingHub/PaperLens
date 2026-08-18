<#
.SYNOPSIS
  PaperLens 一键发布脚本（自动更新模块配套，见 docs/自动更新模块设计.md 六）

.DESCRIPTION
  产物（dist/release/）：
    PaperLens_<v>_x64-setup-full.exe     全量安装包（含 resources ~1.15GB）
    PaperLens_<v>_x64-setup-update.exe   更新包（resources 置空 ~60MB）
    PaperLens_<v>_x64-setup-update.exe.sig  minisign 签名（tauri signer）
    latest.json                            GitHub Release 用 manifest
    latest.mirror.json                     国内镜像用 manifest（-MirrorBaseUrl 时生成，二进制 URL 指向镜像）

  更新包通过 `tauri build --config scripts/updater-config.json` 生成：
  RFC 7396 合并下，resources 逐键 null 才能真正删除（空对象 {} 是 no-op）。
  脚本对更新包做 <200MB 体积断言，防止合并语义回归把 1.15GB 资源打进更新包。

.PARAMETER Version
  本次发布版本号（写入 tauri.conf.json）；省略则沿用当前版本。

.PARAMETER Notes
  更新日志（写入 manifest notes）。

.PARAMETER SkipServer
  跳过 server onefile 打包（binaries/ 已有最新 sidecar 时）。

.PARAMETER SkipFull
  跳过全量安装包（本机未准备 bundle-resources/ 大资产、仅迭代更新包时）。

.PARAMETER SkipUpload
  跳过 gh 上传（默认在产物就绪后调用 gh release create）。

.PARAMETER MirrorBaseUrl
  国内镜像二进制下载基址（如 ModelScope 仓库文件直链前缀），
  用于生成 latest.mirror.json；镜像上传需另行手动/CLI 完成。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build_release.ps1 -Version 0.2.0 -Notes "修复若干问题"
#>
param(
  [string]$Version,
  [string]$Notes = '',
  [switch]$SkipServer,
  [switch]$SkipFull,
  [switch]$SkipUpload,
  [string]$MirrorBaseUrl
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$confPath = 'apps/desktop/src-tauri/tauri.conf.json'
$conf = Get-Content $confPath -Raw | ConvertFrom-Json

# ── 1. 版本号（可选写入 tauri.conf.json，仅替换唯一的顶层 version 字段）──
if ($Version -and $Version -ne $conf.version) {
  (Get-Content $confPath -Raw) -replace '"version": "[^"]*"', "`"version`": `"$Version`"" |
    Set-Content $confPath -Encoding utf8NoBOM
} else {
  $Version = $conf.version
}
Write-Host "==> 发布版本 v$Version"

# ── 2. 前端构建 ──
Write-Host '==> npm run build（前端）'
Push-Location apps/desktop
npm run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
Pop-Location

# ── 3. server onefile（覆盖 binaries/ 占位 stub）──
if (-not $SkipServer) {
  Write-Host '==> PyInstaller server onefile'
  & .venv\Scripts\pyinstaller.exe --noconfirm scripts\package_server_onefile.spec --distpath dist --workpath dist\.work-server-onefile
  if ($LASTEXITCODE -ne 0) { throw 'server 打包失败' }
  Copy-Item dist\paperlens-server.exe apps\desktop\src-tauri\binaries\paperlens-server-x86_64-pc-windows-msvc.exe -Force
}

# ── 4. 签名环境变量（私钥丢失将无法再发布更新，务必备份 scripts/keys/）──
$keyPath = 'scripts\keys\paperlens-updater.key'
if (-not (Test-Path $keyPath)) { throw "签名私钥不存在：$keyPath" }
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''

$releaseDir = 'dist\release'
New-Item -ItemType Directory -Force $releaseDir | Out-Null
$nsisDir = 'apps\desktop\src-tauri\target\release\bundle\nsis'

function Move-Artifacts([string]$Suffix) {
  $setup = Get-ChildItem "$nsisDir\PaperLens_${Version}_x64-setup.exe" -ErrorAction Stop
  $sig = Get-ChildItem "$nsisDir\PaperLens_${Version}_x64-setup.exe.sig" -ErrorAction Stop
  $dest = "$releaseDir\PaperLens_${Version}_x64-setup-${Suffix}.exe"
  Move-Item $setup.FullName $dest -Force
  Move-Item $sig.FullName "$dest.sig" -Force
  return $dest
}

# ── 5. 全量安装包（含 resources）──
if (-not $SkipFull) {
  Write-Host '==> tauri build 全量包'
  Push-Location apps/desktop
  npx tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw '全量包构建失败' }
  Pop-Location
  $full = Move-Artifacts 'full'
  Write-Host ("    全量包：{0}（{1:N0} MB）" -f $full, ((Get-Item $full).Length / 1MB))
}

# ── 6. 更新包（resources 置空 → 仅代码 ~60MB）──
Write-Host '==> tauri build 更新包（resources 置空）'
Push-Location apps/desktop
npx tauri build --bundles nsis --config ..\..\scripts\updater-config.json
if ($LASTEXITCODE -ne 0) { throw '更新包构建失败' }
Pop-Location
$update = Move-Artifacts 'update'
$updateMB = (Get-Item $update).Length / 1MB
Write-Host ("    更新包：{0}（{1:N0} MB）" -f $update, $updateMB)
# 体积断言：若 RFC 7396 语义变化或 tauri.conf.json resources 键与 updater-config.json 失配，
# 更新包会把 1.15GB 资源打进来 —— 直接失败，避免发布废包
if ($updateMB -ge 200) { throw "更新包 $([int]$updateMB)MB ≥ 200MB：resources 置空未生效，请核对 updater-config.json 与 tauri.conf.json 的 resources 键" }

# ── 7. 生成 manifest（latest.json v2 格式）──
$signature = (Get-Content "$update.sig" -Raw).Trim()
$ghUrl = "https://github.com/HanQingHub/PaperLens/releases/download/v$Version/PaperLens_${Version}_x64-setup-update.exe"
$pubDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$manifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = $pubDate
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = $signature
      url       = $ghUrl
    }
  }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content "$releaseDir\latest.json" -Encoding utf8NoBOM
Write-Host "    manifest：$releaseDir\latest.json → $ghUrl"

if ($MirrorBaseUrl) {
  $manifest.platforms.'windows-x86_64'.url = "$($MirrorBaseUrl.TrimEnd('/'))/PaperLens_${Version}_x64-setup-update.exe"
  $manifest | ConvertTo-Json -Depth 5 | Set-Content "$releaseDir\latest.mirror.json" -Encoding utf8NoBOM
  Write-Host "    镜像 manifest：$releaseDir\latest.mirror.json（上传至镜像后覆盖 latest.json）"
}

# ── 8. 上传 GitHub Releases（gh CLI；镜像需另行上传）──
if (-not $SkipUpload) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    Write-Host "==> gh release create v$Version"
    $assets = @(Get-ChildItem "$releaseDir\PaperLens_${Version}_x64-setup-*.exe*") + @("$releaseDir\latest.json")
    & gh release create "v$Version" @($assets | ForEach-Object FullName) --title "PaperLens v$Version" --notes $Notes
    if ($LASTEXITCODE -ne 0) { throw 'gh release create 失败' }
    Write-Host '    GitHub Release 已创建。请手动将 latest.mirror.json（如有）与更新包上传至国内镜像。'
  } else {
    Write-Host '==> 未安装 gh CLI，跳过上传。产物在 dist/release/，请手动发布。' -ForegroundColor Yellow
  }
} else {
  Write-Host '==> 已按参数跳过上传。产物清单：'
  Get-ChildItem $releaseDir | Format-Table Name, @{n = 'MB'; e = { [int]($_.Length / 1MB) } }
}
