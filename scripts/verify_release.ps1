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
  [string]$ReleaseDir = 'dist\release'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$releaseDir = if ([System.IO.Path]::IsPathRooted($ReleaseDir)) { $ReleaseDir } else { Join-Path $repo $ReleaseDir }

$update = Get-ChildItem "$releaseDir\PaperLens_*_x64-setup-update.exe" -ErrorAction Stop | Select-Object -First 1
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
  $pubKey = 'scripts\keys\paperlens-updater.key.pub'
  if ((Get-Command minisign -ErrorAction SilentlyContinue) -and (Test-Path $pubKey)) {
    & minisign -Vm $update.FullName -P (Get-Content $pubKey -Raw) 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $fail += 'minisign verify 失败' } else { Write-Host '    minisign verify OK' }
  } else {
    Write-Host '    minisign 或公钥不可用，降级为存在性检查' -ForegroundColor Yellow
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