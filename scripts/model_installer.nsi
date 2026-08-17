Unicode true

Name "PaperLens 2B 模型包"
OutFile "..\dist\PaperLens_Qwen3.5-2B-Q4_K_M_installer.exe"
InstallDir "D:\PaperLens\models"

RequestExecutionLevel user

; GGUF 不可压缩（LZMA 仅省 ~17MB），且 NSIS /SOLID lzma 对单文件 >1GiB 的解压会挂起（实测 0 字节卡死）
; 故用不压缩存储，简单可靠
SetCompress off

!include MUI2.nsh

!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "2B 模型已安装到 PaperLens 数据目录（D:\PaperLens\models）。重新打开 PaperLens 后即可在设置页切换到 Qwen3.5-2B。"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ; 与 apps/server/app/core/config.py 的数据目录判定逐位一致：
  ; D 盘存在 -> D:\PaperLens\models，否则 -> %LOCALAPPDATA%\PaperLens\models。
  ; 刻意不提供目录选择页：模型必须落在应用实际扫描的目录，避免装错位置。
  ; 注意：${FileExists} "D:\" 对盘根判定不可靠（实测 D 盘存在仍返回 false），
  ; 必须用 GetDriveType（返回 1=DRIVE_NO_ROOT_DIR 表示盘不存在）。
  System::Call 'kernel32::GetDriveType(t "D:\") i .R0'
  ${If} $R0 <> 1
    StrCpy $INSTDIR "D:\PaperLens\models"
    DetailPrint "D drive exists, INSTDIR=$INSTDIR"
  ${Else}
    StrCpy $INSTDIR "$LOCALAPPDATA\PaperLens\models"
    DetailPrint "No D drive, INSTDIR=$INSTDIR"
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File "..\assets\models\Qwen3.5-2B-Q4_K_M.gguf"
  WriteRegStr HKCU "Software\PaperLens\model-2b" "InstallDir" "$INSTDIR"
SectionEnd
