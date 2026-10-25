; ZMod 一键安装器（NSIS）
; 构建：node tools/build-installer.cjs（传 -DVERSION/-DSTAGING_DIR/-DOUT_FILE）
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Unicode true
Name "ZMod ${VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\ZMod"
InstallDirRegKey HKCU "Software\ZMod" "InstallDir"
RequestExecutionLevel user
ShowUninstDetails show

Var /GLOBAL unKeepDataState
Var /GLOBAL unKeepDataCheckbox

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "ZMod 文件将被释放到此目录（与 ZCode 客户端目录无关，保持默认即可）"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

; ---- 卸载页：保留用户数据（默认勾选） ----
UninstPage custom un.PageKeepData un.PageKeepDataLeave

Function un.PageKeepData
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "卸载将移除 ZMod 程序文件。用户数据（配置、数据源、插件、基线快照）位于安装目录的 data 子目录。"
  Pop $0
  ${NSD_CreateCheckbox} 0 30u 100% 12u "保留用户数据（推荐，配置与数据源会保留）"
  Pop $unKeepDataCheckbox
  ${NSD_Check} $unKeepDataCheckbox
  StrCpy $unKeepDataState "1"
  nsDialogs::Show
FunctionEnd

Function un.PageKeepDataLeave
  ${NSD_GetState} $unKeepDataCheckbox $unKeepDataState
FunctionEnd

Section "ZMod"
  SetOutPath "$INSTDIR"
  File /r "${STAGING_DIR}\*"
  DetailPrint "文件已释放到 $INSTDIR"

  ; ZCode 运行中会锁住 asar，先检测并征询关闭
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ZCode.exe" /NH | find /i "ZCode.exe" >nul'
  Pop $0
  ${If} $0 == 0
    MessageBox MB_OKCANCEL|MB_ICONQUESTION "检测到 ZCode 正在运行。$\r$\n$\r$\n安装需要完全退出 ZCode，点击 [确定] 自动关闭并继续；未保存的会话内容请先处理。" IDOK close_zcode
    Abort "已取消安装。"
close_zcode:
    DetailPrint "正在关闭 ZCode ..."
    nsExec::ExecToLog 'taskkill /f /im ZCode.exe'
    Sleep 2000
  ${EndIf}

  DetailPrint "正在安装 ZMod 到 ZCode ..."
  ExecWait '"$INSTDIR\run-install.cmd" install' $0
  ${If} $0 != 0
    ${If} $0 == 2
      MessageBox MB_OK|MB_ICONSTOP "安装未完成：app.asar 被占用（ZCode 可能在安装期间被重新打开，或杀毒软件正在扫描）。$\r$\n$\r$\n请完全退出 ZCode 后，到安装目录重新运行 run-install.cmd 即可，无需重装。$\r$\n详细日志: $INSTDIR\data\logs\install-latest.log"
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "安装失败（退出码 $0）。$\r$\n详细日志: $INSTDIR\data\logs\install-latest.log$\r$\n请把日志内容反馈给开发者。"
    ${EndIf}
    DetailPrint "install exit code: $0"
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "ZMod 安装成功！$\r$\n$\r$\n启动 ZCode 后按 Ctrl+Shift+M 打开 ZMod 管理面板。"
  ${EndIf}

  WriteRegStr HKCU "Software\ZMod" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\run-install.cmd" 0 +4
    MessageBox MB_YESNO|MB_ICONQUESTION "卸载前建议先还原 ZCode 官方客户端（运行 restore）。$\r$\n$\r$\n现在先运行还原吗？" IDNO +3
    ExecWait '"$INSTDIR\run-install.cmd" restore'
    Sleep 1000

  ${If} $unKeepDataState != "0"
    ${AndIf} ${FileExists} "$INSTDIR\data"
    ; 数据目录在安装目录内：逐项删除 data 以外的内容（RMDir /r 会连 data 一起删，
    ; 而 Rename 到 $TEMP 跨盘会失败，因此不能整目录挪走）
    ClearErrors
    FindFirst $0 $1 "$INSTDIR\*"
    un_del_loop:
      IfErrors un_del_done
      StrCmp "$1" "." un_del_next
      StrCmp "$1" ".." un_del_next
      StrCmp "$1" "data" un_del_next
      RMDir /r "$INSTDIR\$1"
    un_del_next:
      FindNext $0 $1
      Goto un_del_loop
    un_del_done:
      FindClose $0
      RMDir "$INSTDIR"
  ${Else}
    RMDir /r "$INSTDIR"
  ${EndIf}
  DeleteRegKey HKCU "Software\ZMod"
SectionEnd
