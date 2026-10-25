; ZMod 一键安装器（NSIS）
; 构建：node tools/build-installer.cjs（传 -DVERSION/-DSTAGING_DIR/-DOUT_FILE）
; 安装/卸载全程不出现 cmd 窗口：CLI 由 nsExec 隐藏执行，输出进详情页，
; 解释器发现（系统 node → HostDir 缓存 → ZCode 固定路径 → 运行进程）原为
; run-install.cmd 的职责，现内置于 NSIS。
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "Util.nsh"
!include "FileFunc.nsh"
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
; border v2 图标（源: assets/icons/border_v2_uninst.ico）
!define MUI_ICON "${__FILEDIR__}\icons\installer.ico"
!define MUI_UNICON "${__FILEDIR__}\icons\uninstaller.ico"
Icon "${__FILEDIR__}\icons\installer.ico"
UninstallIcon "${__FILEDIR__}\icons\uninstaller.ico"
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "ZMod 文件将被释放到此目录（与 ZCode 客户端目录无关，保持默认即可）"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
; 卸载页面流：确认 → 保留数据勾选 → 卸载进度。
; 若缺 MUI_UNPAGE 宏，卸载器只剩自绘页孤岛，出现"只有关闭/取消"的空壳窗口
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.PageKeepData un.PageKeepDataLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------------------------------------------------------------------------
; 共用工具（安装/卸载各实例化一份，NSIS 函数命名空间隔离）
; ---------------------------------------------------------------------------

; 取 $1 的首行（按 CR/LF 截断）存入 $R9，供解析 where/PowerShell 多行输出
!macro FIRST_LINE UN
Function ${UN}FirstLine
  StrCpy $R9 ""
  StrCpy $3 0
  ${Do}
    StrCpy $2 $1 1 $3
    ${If} $2 == ""
      ${ExitDo}
    ${EndIf}
    ${If} $2 == "$\r"
    ${OrIf} $2 == "$\n"
      ${ExitDo}
    ${EndIf}
    StrCpy $R9 $R9$2
    IntOp $3 $3 + 1
  ${Loop}
FunctionEnd
!macroend

; 解释器发现：$R9 = 可执行文件全路径（空=未找到），$R8 = node|electron。
; electron 表示需以 ELECTRON_RUN_AS_NODE=1 运行；命中 ZCode.exe 时把宿主
; 目录写入 HostDir 缓存，供下次升级免枚举。
!macro RESOLVE_INTERPRETER UN
Function ${UN}ResolveNodeInterpreter
  StrCpy $R9 ""
  StrCpy $R8 "node"

  nsExec::ExecToStack 'cmd /c where node'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Call ${UN}FirstLine
    ${If} $R9 != ""
      Return
    ${EndIf}
  ${EndIf}

  StrCpy $R8 "electron"
  ReadRegStr $R9 HKCU "Software\ZMod" "HostDir"
  ${If} $R9 != ""
  ${AndIf} ${FileExists} "$R9\ZCode.exe"
    StrCpy $R9 "$R9\ZCode.exe"
    Return
  ${EndIf}

  ${If} ${FileExists} "$LOCALAPPDATA\Programs\ZCode\ZCode.exe"
    StrCpy $R9 "$LOCALAPPDATA\Programs\ZCode\ZCode.exe"
    Goto ${UN}interp_found_host
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES\ZCode\ZCode.exe"
    StrCpy $R9 "$PROGRAMFILES\ZCode\ZCode.exe"
    Goto ${UN}interp_found_host
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES32\ZCode\ZCode.exe"
    StrCpy $R9 "$PROGRAMFILES32\ZCode\ZCode.exe"
    Goto ${UN}interp_found_host
  ${EndIf}

  nsExec::ExecToStack 'powershell -NoProfile -Command "(Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1).Path"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Call ${UN}FirstLine
    ${If} $R9 != ""
    ${AndIf} ${FileExists} "$R9"
      Goto ${UN}interp_found_host
    ${EndIf}
  ${EndIf}
  StrCpy $R9 ""
  Return

${UN}interp_found_host:
  ${GetParent} "$R9" $1
  ${If} $1 != ""
    WriteRegStr HKCU "Software\ZMod" "HostDir" "$1"
  ${EndIf}
FunctionEnd
!macroend

!insertmacro FIRST_LINE ""
!insertmacro RESOLVE_INTERPRETER ""
!insertmacro FIRST_LINE "un."
!insertmacro RESOLVE_INTERPRETER "un."

Function un.PageKeepData
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "卸载会先自动还原 ZCode 官方客户端，再移除 ZMod 程序文件。用户数据（配置、数据源、插件、基线快照）位于安装目录的 data 子目录。"
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
    MessageBox MB_OKCANCEL|MB_ICONQUESTION "检测到 ZCode 正在运行。$\r$\n$\r$\n安装需要完全退出 ZCode，点击 [确定] 自动关闭并继续；未保存的会话内容请先处理。" /SD IDOK IDOK close_zcode
    Abort "已取消安装。"
close_zcode:
    DetailPrint "正在关闭 ZCode ..."
    nsExec::ExecToLog 'taskkill /f /im ZCode.exe'
    Sleep 2000
  ${EndIf}

  DetailPrint "正在定位运行时（Node.js / ZCode）..."
  Call ResolveNodeInterpreter
  StrCmp $R9 "" install_no_interp
  DetailPrint "运行时: $R9"
  StrCmp $R8 "electron" 0 install_run
  System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'

install_run:
  DetailPrint "正在安装 ZMod 到 ZCode ..."
  nsExec::ExecToLog '"$R9" "$INSTDIR\packages\zmod-cli\bin\zmod.js" install'
  Pop $0
  System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)'
  ${If} $0 != 0
    ${If} $0 == 2
      MessageBox MB_OK|MB_ICONSTOP "安装未完成：app.asar 被占用（ZCode 可能在安装期间被重新打开，或杀毒软件正在扫描）。$\r$\n$\r$\n请完全退出 ZCode 后重新运行本安装程序即可完成安装（无需先卸载）。$\r$\n详细日志: $INSTDIR\data\logs\install-latest.log"
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "安装失败（退出码 $0）。$\r$\n详细日志: $INSTDIR\data\logs\install-latest.log$\r$\n请把日志内容反馈给开发者。"
    ${EndIf}
    DetailPrint "install exit code: $0"
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "ZMod 安装成功！$\r$\n$\r$\n启动 ZCode 后按 Ctrl+Shift+M 打开 ZMod 管理面板。"
  ${EndIf}
  Goto install_done

install_no_interp:
  MessageBox MB_OK|MB_ICONSTOP "未找到可用的运行时。$\r$\n$\r$\n请确认本机已安装 ZCode 客户端（或从 nodejs.org 安装 Node.js 18+），然后重新运行本安装程序（直接重跑即可，无需先卸载）。"
  Abort "未找到运行时"

install_done:
  WriteRegStr HKCU "Software\ZMod" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

; 卸载逻辑主体在 zmod-cli（uninstall 命令，清单驱动）；本段只收集选项、
; 调 CLI、清注册表，并在 CLI 不可用时退回目录枚举兜底。
Section "Uninstall"
  IfFileExists "$INSTDIR\packages\zmod-cli\bin\zmod.js" 0 un_fallback
    Call un.ResolveNodeInterpreter
    StrCmp $R9 "" un_no_interp
    StrCmp $R8 "electron" 0 un_interp_ready
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'

  un_interp_ready:
    StrCmp "$unKeepDataState" "0" un_wipe un_keep
  un_keep:
    nsExec::ExecToLog '"$R9" "$INSTDIR\packages\zmod-cli\bin\zmod.js" uninstall --keep-data'
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)'
    Goto un_after_cli
  un_wipe:
    nsExec::ExecToLog '"$R9" "$INSTDIR\packages\zmod-cli\bin\zmod.js" uninstall --wipe-data'
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)'
    Goto un_after_cli

  ; 无解释器（用户删过 Node 且 ZCode 已被卸载）：CLI 的还原与清单删除都
  ; 跑不了，必须让用户知道官方客户端可能仍是补丁版，再走目录枚举兜底
  un_no_interp:
    MessageBox MB_OK|MB_ICONEXCLAMATION "未找到可用的运行时（Node.js / ZCode），无法自动还原官方客户端。$\r$\n$\r$\nZCode 可能仍是 ZMod 补丁版，如需恢复官方版本请重新安装 ZCode 客户端。$\r$\n$\r$\n点击 [确定] 继续移除 ZMod 程序文件。" /SD IDOK
    Goto un_fallback

  un_after_cli:
    StrCmp "$0" "4" un_restore_warn un_check3
  un_check3:
    StrCmp "$0" "3" un_fallback un_cleanup
  ; 卸载完成但官方客户端未能还原（asar 仍是补丁版）：必须让用户知情
  un_restore_warn:
    MessageBox MB_OK|MB_ICONEXCLAMATION "程序文件已卸载，但官方客户端未能还原（无基线或 asar 被占用）。$\r$\n$\r$\nZCode 当前仍是 ZMod 补丁版，可：$\r$\n· 重装 ZMod 后运行 restore 还原，或$\r$\n· 重装 ZCode 客户端恢复官方版本。$\r$\n详细日志: $INSTDIR\data\logs\uninstall-latest.log" /SD IDOK
    Goto un_cleanup

  ; CLI 或清单不可用（用户手删过文件）：目录枚举兜底。
  ; 以 $1 空串判终；RMDir 失败只置错误标志，不能作为循环终止条件
  un_fallback:
    StrCmp "$unKeepDataState" "0" un_fb_wipe un_fb_keep
  un_fb_keep:
    ClearErrors
    FindFirst $0 $1 "$INSTDIR\*"
    un_fb_loop:
      StrCmp $1 "" un_fb_done
      StrCmp $1 "." un_fb_next
      StrCmp $1 ".." un_fb_next
      StrCmp $1 "data" un_fb_next
      IfFileExists "$INSTDIR\$1\*.*" +3 0
      Delete "$INSTDIR\$1"
      Goto un_fb_next
      ClearErrors
      RMDir /r "$INSTDIR\$1"
    un_fb_next:
      FindNext $0 $1
      Goto un_fb_loop
    un_fb_done:
      FindClose $0
      RMDir "$INSTDIR"
      Goto un_cleanup
  un_fb_wipe:
    RMDir /r "$INSTDIR"

  ; run-install.cmd 仅存在于 1.1 之前的老版本，补删防升级残留；Uninstall.exe 自删。
  ; rmdir.nsh 由构建脚本按清单生成（深优先 RMDir，非空即留），补删 CLI 进程
  ; 句柄拖住的空目录与安装目录本身
  un_cleanup:
    Delete "$INSTDIR\run-install.cmd"
    !include "${RMDIR_INCLUDE}"
    ${If} $unKeepDataState == "0"
      DeleteRegKey HKCU "Software\ZMod"
    ${EndIf}
SectionEnd
