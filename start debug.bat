@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

title VCP Chat - npm start

rem 使用 UTF-8 语言环境，减少 Node.js、Electron 及其子进程的中文日志乱码。
set "LANG=zh_CN.UTF-8"
set "LC_ALL=zh_CN.UTF-8"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

echo ============================================================
echo VCP Chat 原生 npm start
echo 项目目录: %CD%
echo 启动时间: %DATE% %TIME%
echo ============================================================
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 npm.cmd，请确认 Node.js 已安装并加入 PATH。
    echo.
    pause
    exit /b 1
)

rem 不启动 Native Splash，不使用托管启动器，直接执行 package.json 的 start。
call npm.cmd start
set "VCP_EXIT_CODE=%ERRORLEVEL%"

echo.
echo ============================================================
echo VCP Chat 已退出
echo 退出码: %VCP_EXIT_CODE%
echo 结束时间: %DATE% %TIME%
echo ============================================================
echo.
pause

exit /b %VCP_EXIT_CODE%