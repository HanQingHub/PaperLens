# 0.6.1 发版后台 wrapper：PATH 补 minisign（非交互会话 PATH 受限）+ 日志重定向
$env:Path += ';D:\tools\minisign\minisign-win64'
Set-Location 'D:\github\PDF-reader'
pwsh -NoProfile -File 'D:\github\PDF-reader\scripts\build_release.ps1' -Version 0.6.1 -SkipFull -Notes "FLIP 网格重排动画 · 生词复习独立大页与分组管理 · 复习/分组/白屏/UI 细节修复 · Waves 波纹背景" *> 'D:\github\PDF-reader\dist\release-build-0.6.1.log' 2>&1
$code = $LASTEXITCODE
"BUILD_EXIT_CODE=$code" | Out-File 'D:\github\PDF-reader\dist\release-build-0.6.1.log' -Append