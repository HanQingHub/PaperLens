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
  本次发布版本号（仅校验 conf/package.json/Cargo.toml 三处一致，不代写）；省略则沿用当前版本。

.PARAMETER Notes
  更新日志（写入 manifest notes）。

.PARAMETER SkipServer
  跳过 server onefile 打包（binaries/ 已有最新 sidecar 时）。

.PARAMETER SkipFull
  跳过全量安装包（本机未准备 bundle-resources/ 大资产、仅迭代更新包时）。

.PARAMETER SkipUpload
  跳过 gh 上传（默认在产物就绪后调用 gh release create）。

.PARAMETER SkipTests
  跳过测试闸门（不推荐：默认构建前跑 apps/server 与 apps/ocr-worker 全量 pytest）。

.PARAMETER PyVenv
  Python venv 目录（默认探测仓库根 .venv）。

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
  [switch]$SkipTests,
  [string]$PyVenv,
  [string]$MirrorBaseUrl
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$confPath = 'apps/desktop/src-tauri/tauri.conf.json'
$conf = Get-Content $confPath -Raw | ConvertFrom-Json

# ── 发布红线前置校验（手册 §1.1，违反即中止）──
$dirty = git status --porcelain | Where-Object { $_ -notmatch '^\?\?' }
if ($dirty) { throw "发布红线：工作区存在未提交改动，先 commit 并 push 再发布：`n$($dirty -join "`n")" }
try { git fetch origin master 2>$null | Out-Null } catch { Write-Warning "git fetch 失败（离线？），按本地缓存的 origin/master 比较" }
$ahead = [int](git rev-list --count origin/master..HEAD)
if ($ahead -gt 0) { throw "发布红线：本地领先 origin/master $ahead 个提交，先 git push 再发布" }
$pkgVer = (Get-Content 'apps/desktop/package.json' -Raw | ConvertFrom-Json).version
$tomlVer = ([regex]::Match((Get-Content 'apps/desktop/src-tauri/Cargo.toml' -Raw), '(?m)^version\s*=\s*"([^"]+)"')).Groups[1].Value
if ($Version -and ($conf.version -ne $Version -or $pkgVer -ne $Version -or $tomlVer -ne $Version)) {
  throw "发布红线：版本号三处不一致 conf=$($conf.version) pkg=$pkgVer toml=$tomlVer 期望=$Version"
}

# ── 1. 版本号（仅校验三处一致、不代写；conf/package.json/Cargo.toml 需预先手工改齐）──
if ($Version -and $Version -notmatch '^v?\d+\.\d+\.\d+$') {
  throw "版本号格式非法：$Version（应为 v?\d+.\d+.\d+）"
}
$Version = $conf.version
Write-Host "==> 发布版本 v$Version"

# ── 2. 测试闸门（构建前：apps/server + apps/ocr-worker 全量 pytest）──
if (-not $SkipTests) {
  if (-not $PyVenv) {
    $candidates = @("$repo\.venv", "$repo\apps\server\.venv", "$repo\apps\ocr-worker\.venv")
    $PyVenv = $candidates | Where-Object { Test-Path "$_\Scripts\python.exe" } | Select-Object -First 1
  }
  if (-not $PyVenv -or -not (Test-Path "$PyVenv\Scripts\python.exe")) {
    throw "未找到 Python venv（可用 -PyVenv 指定，如 -PyVenv D:\github\PDF-reader\.venv）"
  }
  $py = "$PyVenv\Scripts\python.exe"
  foreach ($suite in @('apps\server', 'apps\ocr-worker')) {
    if (-not (Test-Path "$repo\$suite\tests")) {
      Write-Host "==> 测试闸门：$suite 无 tests 目录，跳过" -ForegroundColor Yellow
      continue
    }
    Write-Host "==> 测试闸门：$suite pytest 全量"
    Push-Location $repo\$suite
    & $py -m pytest -q
    $testCode = $LASTEXITCODE
    Pop-Location
    if ($testCode -ne 0) { throw "$suite 测试失败（exit $testCode），中止发布" }
  }
} else {
  Write-Host '==> 已按参数跳过测试闸门' -ForegroundColor Yellow
}

# ── 3. OCR worker 产物门禁（tauri.conf resources 引用 ocr-dist/paperlens-ocr）──
$ocrExe = 'apps\desktop\src-tauri\ocr-dist\paperlens-ocr\paperlens-ocr.exe'
if (-not (Test-Path $ocrExe)) {
  throw "OCR worker 打包产物缺失：$ocrExe（需先运行 package_ocr_worker.spec）"
}

# ── 4. 前端构建 ──
Write-Host '==> npm run build（前端）'
Push-Location apps/desktop
npm run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
Pop-Location

# ── 5. server onedir（同步 binaries/paperlens-server/ 目录，随 bundle.resources 打包）──
if (-not $SkipServer) {
  Write-Host '==> PyInstaller server onedir'
  & .venv\Scripts\pyinstaller.exe --noconfirm scripts\package_server.spec --distpath dist --workpath dist\.work-server
  if ($LASTEXITCODE -ne 0) { throw 'server 打包失败' }
  $dest = 'apps\desktop\src-tauri\binaries\paperlens-server'
  Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item dist\paperlens-server $dest -Recurse -Force
  $copied = Join-Path $dest 'paperlens-server.exe'
  if (-not (Test-Path $copied)) { throw 'server 产物同步到 binaries 失败' }
}

# ── 6. 签名环境变量（私钥丢失将无法再发布更新，务必备份 scripts/keys/）──
$keyPath = 'scripts\keys\paperlens-updater.key'
if (-not (Test-Path $keyPath)) { throw "签名私钥不存在：$keyPath" }
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
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

# ── 7. 全量安装包（含 resources）──
if (-not $SkipFull) {
  Write-Host '==> tauri build 全量包'
  Push-Location apps/desktop
  npx tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw '全量包构建失败' }
  Pop-Location
  $full = Move-Artifacts 'full'
  Write-Host ("    全量包：{0}（{1:N0} MB）" -f $full, ((Get-Item $full).Length / 1MB))
}

# ── 8. 更新包（resources 置空 → 仅代码 ~60MB）──
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

# ── 9. 生成 manifest（latest.json v2 格式）──
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

# ── 10. 产物断言（签名 / 体积 / manifest，见 scripts/verify_release.ps1）──
& "$PSScriptRoot\verify_release.ps1" -Version $Version -ReleaseDir 'dist\release'
if ($LASTEXITCODE -ne 0) { throw '产物验证失败，中止发布' }

# ── 11. 上传 GitHub Releases（gh CLI；镜像需另行上传）──
if (-not $SkipUpload) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    # 新用户指引：发 full 指向自身；仅更新包时指向最近一个带全量包的 release（手册 §1.1 规则 7）
    if (-not $SkipFull) {
      $fullHint = "**新用户安装**：下载本页下方的 ``PaperLens_${Version}_x64-setup-full.exe`` 全量安装包安装；首次启动后在「设置 → 检查更新」保持最新。"
    } else {
      $relObj = (gh api "repos/HanQingHub/PaperLens/releases?per_page=50") | ConvertFrom-Json
      $src = $null
      foreach ($r in @($relObj)) {
        if ($r.tag_name -eq "v$Version") { continue }
        $f = $r.assets | Where-Object { $_.name -match '^PaperLens_.+_x64-setup(-full)?\.exe$' } | Select-Object -First 1
        if ($f) { $src = @{ tag = $r.tag_name; file = $f.name }; break }
      }
      if ($src) {
        $fullHint = "**新用户安装**：本版本仅提供更新包。请先到 [$($src.tag)](https://github.com/HanQingHub/PaperLens/releases/tag/$($src.tag)) 下载全量安装包 ``$($src.file)`` 安装，然后在「设置 → 检查更新」一键升级到当前版本。"
      } else {
        Write-Warning '未找到任何含全量安装包的 release，新用户指引留空。'
        $fullHint = ''
      }
    }
    $nl = [char]10
    $releaseNotes = ((@($Notes, $fullHint) | Where-Object { $_ }) -join ($nl + $nl + '---' + $nl + $nl))
    Write-Host "==> gh release create v$Version"
    $assets = @(Get-ChildItem "$releaseDir\PaperLens_${Version}_x64-setup-*.exe*") + @("$releaseDir\latest.json")
    & gh release create "v$Version" @($assets | ForEach-Object FullName) --title "v$Version" --notes $releaseNotes
    if ($LASTEXITCODE -ne 0) { throw 'gh release create 失败' }
    Write-Host '    GitHub Release 已创建。请手动将 latest.mirror.json（如有）与更新包上传至国内镜像。'
  } else {
    Write-Host '==> 未安装 gh CLI，跳过上传。产物在 dist/release/，请手动发布。' -ForegroundColor Yellow
  }
} else {
  Write-Host '==> 已按参数跳过上传。产物清单：'
  Get-ChildItem $releaseDir | Format-Table Name, @{n = 'MB'; e = { [int]($_.Length / 1MB) } }
}
