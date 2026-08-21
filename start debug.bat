@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

title VCP Chat Debug Console

set "ELECTRON_ENABLE_LOGGING=1"
set "ELECTRON_ENABLE_STACK_DUMPING=1"

echo ============================================================
echo VCP Chat Debug Launcher
echo Working directory: %CD%
echo Started at: %DATE% %TIME%
echo ============================================================
echo.

if exist "NativeSplash.exe" (
    start "" "NativeSplash.exe"
)

call npm start
set "VCP_EXIT_CODE=%ERRORLEVEL%"

echo.
echo ============================================================
echo Electron process exited.
echo Exit code: %VCP_EXIT_CODE%
echo Finished at: %DATE% %TIME%
echo.
echo 请保留并复制上方最后一段错误输出。
echo 按任意键关闭此调试终端。
echo ============================================================
pause >nul

exit /b %VCP_EXIT_CODE%