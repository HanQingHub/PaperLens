<#
.SYNOPSIS
  PaperLens 发布产物验证脚本（T13：签名 / 体积 / manifest 断言）

.DESCRIPTION
  验证 dist/release/ 下的发布产物：
    - 更新包与 .sig 存在且非空
    - minisign 可用且公钥存在时执行 verify，否则降级为存在性检查
    - 更新包体积 < 200MB（resources 置空未生效会打爆体积）
    - latest.json 可解析、version 与目标版本一致、url 为合法 https 链接

.PARAMETER Version
  目标版本号（如 0.3.0），省略则从 latest.json 读取。

.PARAMETER ReleaseDir
  产物目录，默认 dist\release（相对仓库根）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/verify_release.ps1 -Version 0.3.0
#>
param(
  [string]$Version,
  [string]$ReleaseDir = 'dist\release',
  # 缺 minisign 时显式降级为存在性检查（默认缺工具即失败，签名是唯一信任锚）
  [switch]$AllowDegraded
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$releaseDir = if ([System.IO.Path]::IsPathRooted($ReleaseDir)) { $ReleaseDir } else { Join-Path $repo $ReleaseDir }

# 多版本产物共存时按 LastWriteTime 取最新（字母序会误选旧版本，如 0.2.7 < 0.3.0）
$update = Get-ChildItem "$releaseDir\PaperLens_*_x64-setup-update.exe" -ErrorAction Stop |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$version = $Version
if (-not $version) {
  $version = ($update.BaseName -replace '^PaperLens_|_x64-setup-update$', '')
}
Write-Host "==> 验证 v$version 产物（$releaseDir）"

$fail = @()
$sigPath = "$($update.FullName).sig"
if (-not (Test-Path $update.FullName) -or $update.Length -le 0) {
  $fail += '更新包缺失或为空'
} else {
  Write-Host ("    更新包：{0}（{1:N0} MB）" -f $update.Name, ($update.Length / 1MB))
}
if (-not (Test-Path $sigPath) -or (Get-Item $sigPath).Length -le 0) {
  $fail += '.sig 缺失或为空'
} else {
  Write-Host '    .sig 存在且非空'
  $pubEnvelope = 'scripts\keys\paperlens-updater.key.pub'
  if (-not (Get-Command minisign -ErrorAction SilentlyContinue)) {
    if ($AllowDegraded) {
      Write-Host '    minisign 不可用，已按 -AllowDegraded 降级为存在性检查' -ForegroundColor Yellow
    } else {
      $fail += 'minisign 不可用，无法验证签名（安装 minisign，或显式传 -AllowDegraded 降级）'
    }
  } elseif (-not (Test-Path $pubEnvelope)) {
    $fail += "公钥缺失：$pubEnvelope"
  } else {
    # tauri signer 的 .pub 与 .sig 都是单行 base64 信封；stock minisign 只认
    # 传统多行格式、且默认找 .minisig 后缀——双双解信封写临时文件，
    # 用 -p（公钥）+ -x（签名）完成验证
    $tmpPub = Join-Path ([System.IO.Path]::GetTempPath()) 'paperlens-verify.pub'
    $tmpSig = Join-Path ([System.IO.Path]::GetTempPath()) 'paperlens-verify.minisig'
    try {
      $rawPub = (Get-Content $pubEnvelope -Raw).Trim()
      [System.IO.File]::WriteAllText(
        $tmpPub,
        [System.Text.Encoding]::ASCII.GetString([Convert]::FromBase64String($rawPub))
      )
      $rawSig = (Get-Content "$($update.FullName).sig" -Raw).Trim()
      [System.IO.File]::WriteAllText(
        $tmpSig,
        [System.Text.Encoding]::ASCII.GetString([Convert]::FromBase64String($rawSig))
      )
      & minisign -Vm $update.FullName -p $tmpPub -x $tmpSig 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { $fail += 'minisign verify 失败' } else { Write-Host '    minisign verify OK' }
    } catch {
      $fail += "签名/公钥信封解码失败：$_"
    } finally {
      Remove-Item $tmpPub, $tmpSig -Force -ErrorAction SilentlyContinue
    }
  }
}

$updateMB = $update.Length / 1MB
if ($updateMB -ge 200) { $fail += "更新包 $([int]$updateMB)MB ≥ 200MB：resources 置空未生效" }

$manifestPath = "$releaseDir\latest.json"
if (-not (Test-Path $manifestPath)) {
  $fail += 'latest.json 缺失'
} else {
  try {
    $m = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($m.version -ne $version) {
      $fail += "latest.json version($($m.version)) 与目标版本($version)不一致"
    } else {
      Write-Host "    latest.json version=$($m.version) OK"
    }
    $url = $m.platforms.'windows-x86_64'.url
    if (-not $url) {
      $fail += 'latest.json 缺少 platforms.windows-x86_64.url'
    } else {
      $u = [System.Uri]$url
      if ($u.Scheme -ne 'https') { $fail += "manifest url 非 https：$url" } else { Write-Host "    manifest url OK：$url" }
    }
  } catch {
    $fail += "latest.json 解析失败：$_"
  }
}

if ($fail.Count -gt 0) {
  Write-Host '验证失败：' -ForegroundColor Red
  $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
Write-Host '产物验证全部通过'
exit 0