@echo off
setlocal
chcp 65001 >nul
set "PATH=%~dp0..\runtimes\node;%~dp0..\runtimes\git\cmd;%~dp0..\runtimes\python;%~dp0..\runtimes\python\Scripts;%PATH%"
cd /d "%~dp0"
echo [VCP] Starting VCPChat Desktop...
START "" "NativeSplash.exe"
call npm start
pause
