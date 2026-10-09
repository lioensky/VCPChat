@echo off
setlocal
chcp 65001 >nul
title Project source tree generator

rem Always scan the project beside this launcher, not the caller's directory.
set "PROJECT_ROOT=%~dp0"
set "TREE_SCRIPT=%PROJECT_ROOT%scripts\generate_project_tree.py"
set "TREE_OUTPUT=%PROJECT_ROOT%scripts\PROJECT_STRUCTURE.md"

if not exist "%TREE_SCRIPT%" (
    echo [ERROR] Generator not found: "%TREE_SCRIPT%"
    goto :failure
)

rem Prefer a project-local Python, then try the Windows launcher and PATH.
if exist "%PROJECT_ROOT%.venv\Scripts\python.exe" (
    "%PROJECT_ROOT%.venv\Scripts\python.exe" -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_CMD="%PROJECT_ROOT%.venv\Scripts\python.exe""
        goto :generate
    )
)
if exist "%PROJECT_ROOT%venv\Scripts\python.exe" (
    "%PROJECT_ROOT%venv\Scripts\python.exe" -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_CMD="%PROJECT_ROOT%venv\Scripts\python.exe""
        goto :generate
    )
)
py -3 -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    goto :generate
)
python -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    goto :generate
)
python3 -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=python3"
    goto :generate
)

echo [ERROR] Python 3 was not found.
echo Install Python 3 and enable "Add python.exe to PATH", then retry.
goto :failure

:generate
echo Generating the complete project source tree...
echo Dependencies, caches, build outputs, media and model files are filtered.
echo.
%PYTHON_CMD% "%TREE_SCRIPT%" --root "%PROJECT_ROOT%." --output "%TREE_OUTPUT%" ^
    --ext "js,mjs,cjs,ts,tsx,jsx,vue,svelte,html,htm,css,scss,sass,less,py,pyi,ipynb,rs,go,c,cpp,cc,cxx,h,hpp,hxx,java,kt,kts,cs,swift,php,rb,lua,r,sql,sh,bash,zsh,bat,cmd,vbs,ps1,psm1,psd1,json,jsonc,json5,yaml,yml,toml,xml,ini,cfg,conf,properties,md,rst,txt,lock,example" ^
    --exclude scripts --exclude "开发文档" ^
    --exclude doc --exclude docs --exclude documentation ^
    --exclude test --exclude tests --exclude __tests__ ^
    --exclude example --exclude examples ^
    --exclude artifacts --exclude screenshots --exclude test-results ^
    --exclude reports --exclude models --exclude checkpoints ^
    --exclude pretrained_models --exclude site-packages ^
    --exclude python_embedded --exclude python_embeded ^
    --exclude PROJECT_STRUCTURE.md
if errorlevel 1 goto :failure

echo.
echo [OK] Output: "%TREE_OUTPUT%"
rem Set these environment variables to 1 for non-interactive automation.
if not "%PROJECT_TREE_NO_OPEN%"=="1" start "" notepad.exe "%TREE_OUTPUT%"
if not "%PROJECT_TREE_NO_PAUSE%"=="1" pause
exit /b 0

:failure
echo.
echo [ERROR] Project tree generation failed. See the message above.
if not "%PROJECT_TREE_NO_PAUSE%"=="1" pause
exit /b 1