@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
set "ENGINE_DIR=%ROOT_DIR%rust_audio_engine"
set "DEPLOY_DIR=%ROOT_DIR%audio_engine"
set "SOURCE_EXE=%ENGINE_DIR%\target\release\audio_server.exe"
set "TARGET_EXE=%DEPLOY_DIR%\audio_server.exe"
set "PKGCONF_DIR=H:\VCP\vcpkg\installed\x64-windows-static\tools\pkgconf"
set "PKGCONFIG_DIR=H:\VCP\vcpkg\installed\x64-windows-static\lib\pkgconfig"

echo [VCP] Building Rust audio engine...
echo [VCP] Engine dir: "%ENGINE_DIR%"
echo [VCP] Deploy target: "%TARGET_EXE%"

if not exist "%ENGINE_DIR%\Cargo.toml" (
    echo [VCP][ERROR] Cargo.toml not found: "%ENGINE_DIR%\Cargo.toml"
    goto :fail
)

set "PATH=%PKGCONF_DIR%;%PATH%"
set "PKG_CONFIG_PATH=%PKGCONFIG_DIR%"
set "RUSTFLAGS=-C target-cpu=native"

pushd "%ENGINE_DIR%"
cargo build --release
set "BUILD_EXIT=%ERRORLEVEL%"
popd

if not "%BUILD_EXIT%"=="0" (
    echo [VCP][ERROR] cargo build --release failed with code %BUILD_EXIT%.
    set "EXIT_CODE=%BUILD_EXIT%"
    goto :fail_with_code
)

if not exist "%SOURCE_EXE%" (
    echo [VCP][ERROR] Built executable not found: "%SOURCE_EXE%"
    goto :fail
)

if not exist "%DEPLOY_DIR%" (
    mkdir "%DEPLOY_DIR%"
    if errorlevel 1 (
        echo [VCP][ERROR] Failed to create deploy dir: "%DEPLOY_DIR%"
        goto :fail
    )
)

copy /Y "%SOURCE_EXE%" "%TARGET_EXE%"
if errorlevel 1 (
    echo [VCP][ERROR] Failed to copy executable.
    echo [VCP][ERROR] If VCP or audio_server.exe is running, close it and retry.
    goto :fail
)

echo.
echo [VCP] Done. Deployed audio engine to:
echo [VCP] "%TARGET_EXE%"
echo.
pause
exit /b 0

:fail
set "EXIT_CODE=1"

:fail_with_code
echo.
echo [VCP] Build/deploy failed. Exit code: %EXIT_CODE%
echo.
pause
exit /b %EXIT_CODE%