@echo off
setlocal
set "SCRIPT=%~dp0scripts\check_theme_wallpapers.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
pause
