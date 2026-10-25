@echo off
rem ZMod installer/maintenance entry. No Node.js required:
rem prefers system Node, else runs the ZCode host itself as Node (ELECTRON_RUN_AS_NODE).
rem Usage: run-install.cmd [install^|restore^|uninstall^|doctor] [args...]
rem 退出码直通 CLI（NSIS 安装/卸载外壳依赖它判定失败与兜底）：
rem 全部走 goto 顶层流，禁止在括号块内引用 %errorlevel%（解析期展开会吃掉真实退出码）
setlocal EnableExtensions
cd /d "%~dp0"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=install"
if /i "%CMD%"=="install" goto :shift_run
if /i "%CMD%"=="restore" goto :shift_run
if /i "%CMD%"=="uninstall" goto :shift_run
if /i "%CMD%"=="doctor" goto :shift_run
set "CMD=install"

:shift_run
shift
where node >nul 2>nul
if %errorlevel%==0 goto :run_node

rem ---- no system Node: locate ZCode.exe to use as interpreter ----
set "ZCODE_EXE="
if exist "%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" set "ZCODE_EXE=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if not defined ZCODE_EXE if exist "%ProgramFiles%\ZCode\ZCode.exe" set "ZCODE_EXE=%ProgramFiles%\ZCode\ZCode.exe"
if not defined ZCODE_EXE if exist "%ProgramFiles(x86)%\ZCode\ZCode.exe" set "ZCODE_EXE=%ProgramFiles(x86)%\ZCode\ZCode.exe"
if not defined ZCODE_EXE for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1).Path"`) do if not defined ZCODE_EXE set "ZCODE_EXE=%%i"

if defined ZCODE_EXE goto :run_zcode
echo [!] No system Node.js found, and ZCode.exe could not be located.
echo     Option A: install Node.js LTS from https://nodejs.org then retry.
echo     Option B: pass the ZCode install dir manually, e.g.:
echo       run-install.cmd install --path "C:\Users\you\AppData\Local\Programs\ZCode"
exit /b 1

:run_node
node packages\zmod-cli\bin\zmod.js %CMD% %1 %2 %3 %4
exit /b %errorlevel%

:run_zcode
set "ELECTRON_RUN_AS_NODE=1"
"%ZCODE_EXE%" packages\zmod-cli\bin\zmod.js %CMD% %1 %2 %3 %4
exit /b %errorlevel%
