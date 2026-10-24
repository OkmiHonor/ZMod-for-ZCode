@echo off
rem ZMod installer/maintenance entry. No Node.js required:
rem prefers system Node, else runs the ZCode host itself as Node (ELECTRON_RUN_AS_NODE).
rem Usage: run-install.cmd [install^|restore^|doctor] [args...]
setlocal EnableExtensions
cd /d "%~dp0"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=install"
if /i "%CMD%"=="install" (shift & goto :run)
if /i "%CMD%"=="restore" (shift & goto :run)
if /i "%CMD%"=="doctor" (shift & goto :run)
set "CMD=install"

:run
where node >nul 2>nul
if %errorlevel%==0 (
  node packages\zmod-cli\bin\zmod.js %CMD% %1 %2 %3 %4
  exit /b %errorlevel%
)

rem ---- no system Node: locate ZCode.exe to use as interpreter ----
set "ZCODE_EXE="
if exist "%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" set "ZCODE_EXE=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if not defined ZCODE_EXE if exist "%ProgramFiles%\ZCode\ZCode.exe" set "ZCODE_EXE=%ProgramFiles%\ZCode\ZCode.exe"
if not defined ZCODE_EXE if exist "%ProgramFiles(x86)%\ZCode\ZCode.exe" set "ZCODE_EXE=%ProgramFiles(x86)%\ZCode\ZCode.exe"
if not defined ZCODE_EXE for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1).Path"`) do if not defined ZCODE_EXE set "ZCODE_EXE=%%i"

if not defined ZCODE_EXE (
  echo [!] No system Node.js found, and ZCode.exe could not be located.
  echo     Option A: install Node.js LTS from https://nodejs.org then retry.
  echo     Option B: pass the ZCode install dir manually, e.g.:
  echo       run-install.cmd install --path "C:\Users\you\AppData\Local\Programs\ZCode"
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
"%ZCODE_EXE%" packages\zmod-cli\bin\zmod.js %CMD% %1 %2 %3 %4
exit /b %errorlevel%
