@echo off
setlocal enabledelayedexpansion

set "BASE=%~dp0"
set "BASE=%BASE:~0,-1%"

set "PY=%BASE%\local-image-server\.venv\Scripts\python.exe"
set "PIP=%BASE%\local-image-server\.venv\Scripts\pip.exe"

echo ============================================
echo   AI Designer Lite - One-Click Start
echo ============================================
echo.

REM --- 1. backend\.env ---
if not exist "%BASE%\backend\.env" (
    echo [1/3] Creating backend\.env from template ...
    copy /y "%BASE%\backend\.env.example" "%BASE%\backend\.env" >nul 2>&1
    echo   Done.
) else (
    echo [1/3] backend\.env exists
)

REM --- 2. Python image server ---
echo [2/3] Preparing local image server ...

if not exist "%PY%" (
    echo   Creating Python venv, please wait ...
    py -3 -m venv "%BASE%\local-image-server\.venv" >nul 2>&1
    if !errorlevel! neq 0 (
        echo   ERROR: Failed to create venv. Is Python 3 installed?
        pause
        exit /b 1
    )
)

"%PY%" -c "import fastapi; import uvicorn" 2>nul
if !errorlevel! neq 0 (
    echo   Installing Python dependencies ...
    "%PIP%" install -r "%BASE%\local-image-server\requirements.txt" -q 2>nul
    "%PIP%" install python-multipart -q 2>nul
    echo   Done.
)

echo   Launching image server on port 18080 ...
start "ImageServer-18080" /d "%BASE%\local-image-server" cmd /k "title Image Server (18080) && echo Image Server starting... && %PY% app.py && pause"

REM --- 3. Node backend ---
echo [3/3] Preparing Node backend ...

if not exist "%BASE%\backend\node_modules" (
    echo   Installing npm packages, please wait ...
    pushd "%BASE%\backend"
    call npm install --quiet 2>nul
    popd
    echo   Done.
)

echo   Launching backend on port 3000 ...
start "Backend-3000" /d "%BASE%\backend" cmd /k "title Backend (3000) && echo Backend: http://localhost:3000 && npm run dev"

echo.
echo ============================================
echo   Launched! Two new windows should open:
echo   - Image Server (port 18080)
echo   - Backend (port 3000)
echo.
echo   Dashboard : http://localhost:3000/dashboard.html
echo   Image Gen : http://localhost:3000/image.html
echo.
echo   Admin: admin@localhost / AdminLocal@2026
echo ============================================

REM Open browser after a few seconds
ping -n 5 127.0.0.1 >nul 2>&1
start http://localhost:3000/dashboard.html

endlocal
