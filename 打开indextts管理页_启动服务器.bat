@echo off
setlocal
cd /d "%~dp0WebIndexTTS2"
start "WebIndexTTS2 Server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" "http://localhost:3012"