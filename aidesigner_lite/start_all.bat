@echo off
setlocal enabledelayedexpansion

set "BASE=%~dp0"
set "BASE=%BASE:~0,-1%"
set "LOCAL_ENV=%BASE%\backend\.env.local"
set "LOCAL_ENV_EXAMPLE=%BASE%\backend\.env.local.example"

set "PYTHON_EXE="
set "PY=%BASE%\local-image-server\.venv\Scripts\python.exe"
set "PIP=%BASE%\local-image-server\.venv\Scripts\pip.exe"

echo ============================================
echo   AI Designer Lite - Local One-Click Start
echo ============================================
echo.
echo This launcher uses backend\.env.local for local Windows development.
echo Docker still uses .env.docker and is not affected.
echo.

REM --- 1. local env ---
if not exist "%LOCAL_ENV%" (
    echo [1/4] Creating backend\.env.local from template ...
    copy /y "%LOCAL_ENV_EXAMPLE%" "%LOCAL_ENV%" >nul 2>&1
    if !errorlevel! neq 0 (
        echo   ERROR: Failed to create backend\.env.local
        pause
        exit /b 1
    )
    echo   Done.
) else (
    echo [1/4] backend\.env.local exists
)

REM --- 2. Python image server ---
echo [2/4] Preparing local image server ...

if not exist "%PY%" (
    where py >nul 2>&1
    if !errorlevel! equ 0 (
        set "PYTHON_EXE=py -3"
    ) else (
        where python >nul 2>&1
        if !errorlevel! equ 0 (
            set "PYTHON_EXE=python"
        ) else (
            echo   ERROR: Python 3 was not found. Please install Python 3 and add it to PATH.
            pause
            exit /b 1
        )
    )

    echo   Creating Python venv, please wait ...
    !PYTHON_EXE! -m venv "%BASE%\local-image-server\.venv"
    if !errorlevel! neq 0 (
        echo   ERROR: Failed to create venv. Is Python 3 installed correctly?
        pause
        exit /b 1
    )
)

"%PY%" -c "import fastapi; import uvicorn; import multipart" >nul 2>&1
if !errorlevel! neq 0 (
    echo   Installing Python dependencies ...
    "%PIP%" install -r "%BASE%\local-image-server\requirements.txt"
    "%PIP%" install python-multipart
    if !errorlevel! neq 0 (
        echo   ERROR: Python dependency installation failed.
        pause
        exit /b 1
    )
    echo   Done.
)

REM --- 3. Node backend ---
echo [3/4] Preparing Node backend ...

where npm >nul 2>&1
if !errorlevel! neq 0 (
    echo   ERROR: npm was not found. Please install Node.js LTS and add it to PATH.
    pause
    exit /b 1
)

if not exist "%BASE%\backend\node_modules" (
    echo   Installing npm packages, please wait ...
    pushd "%BASE%\backend"
    call npm install
    if !errorlevel! neq 0 (
        popd
        echo   ERROR: npm install failed.
        pause
        exit /b 1
    )
    popd
    echo   Done.
)

REM --- 4. Launch ---
echo [4/4] Launching services ...
start "ImageServer-18080" /d "%BASE%\local-image-server" "%BASE%\scripts\run_image_server.bat"
start "Backend-3000" /d "%BASE%\backend" "%BASE%\scripts\run_backend_local.bat"

echo.
echo ============================================
echo   Launched! Two new windows should open:
echo   - Image Server: http://127.0.0.1:18080/health
echo   - Backend     : http://localhost:3000/api/health
echo.
echo   Dashboard : http://localhost:3000/dashboard.html
echo   Image Gen : http://localhost:3000/image.html
echo.
echo   Admin: admin@localhost / AdminLocal@2026
echo ============================================

ping -n 5 127.0.0.1 >nul 2>&1
start http://localhost:3000/dashboard.html

endlocal
