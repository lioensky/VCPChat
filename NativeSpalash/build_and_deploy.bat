@echo off
setlocal EnableExtensions

rem NativeSplash Release 编译并部署脚本
rem 输出文件：项目根目录\启动VCPChat.exe

cd /d "%~dp0"
set "SPLASH_DIR=%CD%"
set "PROJECT_ROOT=%SPLASH_DIR%\.."
set "BUILD_OUTPUT=%SPLASH_DIR%\target\release\NativeSplash.exe"
set "DEPLOY_OUTPUT=%PROJECT_ROOT%\StartVCPchat.exe"

echo.
echo ============================================
echo   NativeSplash 编译并部署
echo ============================================
echo 项目目录: %PROJECT_ROOT%
echo.

where cargo >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 cargo，请先安装 Rust 工具链并确认已加入 PATH。
    pause
    exit /b 1
)

echo [1/2] 正在编译 Release 版本...
cargo build --release
if errorlevel 1 (
    echo.
    echo [错误] Rust 编译失败，未部署任何文件。
    pause
    exit /b 1
)

if not exist "%BUILD_OUTPUT%" (
    echo.
    echo [错误] 找不到构建产物：
echo %BUILD_OUTPUT%
    pause
    exit /b 1
)

echo.
echo [2/2] 正在部署启动器...
copy /Y "%BUILD_OUTPUT%" "%DEPLOY_OUTPUT%" >nul
if errorlevel 1 (
    echo.
    echo [错误] 部署失败。请确认“StartVCPchat.exe”没有正在运行。
    pause
    exit /b 1
)

echo.
echo ============================================
echo   部署完成
echo ============================================
echo 输出文件: %DEPLOY_OUTPUT%
echo.
echo 可直接双击“StartVCPchat.exe”启动 VCPChat。
echo.
pause
exit /b 0