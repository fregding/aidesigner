@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "BASE=%~dp0"
set "BASE=%BASE:~0,-1%"
set "LOG=%BASE%\start_all.log"
set "LOCAL_ENV=%BASE%\backend\.env.local"

echo ================================================== > "%LOG%"
echo AI Designer Lite start log >> "%LOG%"
echo Time: %DATE% %TIME% >> "%LOG%"
echo Base: %BASE% >> "%LOG%"
echo ================================================== >> "%LOG%"

cls
echo ==================================================
echo AI Designer Lite - One Click Start
echo ==================================================
echo.
echo Base directory:
echo %BASE%
echo.

REM Avoid non-portable Python venv from old computers.
if exist "%BASE%\local-image-server\.venv" (
    echo Removing non-portable local-image-server\.venv ...
    rmdir /s /q "%BASE%\local-image-server\.venv" >> "%LOG%" 2>&1
)

REM Create local env file if missing.
if not exist "%LOCAL_ENV%" (
    echo Creating backend\.env.local ...
    > "%LOCAL_ENV%" echo PORT=3000
    >> "%LOCAL_ENV%" echo NODE_ENV=development
    >> "%LOCAL_ENV%" echo TRUST_PROXY=false
    >> "%LOCAL_ENV%" echo PUBLIC_UPLOADS_ENABLED=true
    >> "%LOCAL_ENV%" echo SIGNED_UPLOADS_ENABLED=false
    >> "%LOCAL_ENV%" echo DATA_DIR=./data
    >> "%LOCAL_ENV%" echo DB_PATH=./data/aimaster.db
    >> "%LOCAL_ENV%" echo UPLOAD_DIR=./uploads
    >> "%LOCAL_ENV%" echo ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
    >> "%LOCAL_ENV%" echo ADMIN_EMAIL=admin@localhost
    >> "%LOCAL_ENV%" echo ADMIN_PASSWORD=AdminLocal@2026
    >> "%LOCAL_ENV%" echo JWT_SECRET=local-dev-jwt-secret-change-before-production-1234567890
    >> "%LOCAL_ENV%" echo CONFIG_ENCRYPTION_KEY=local-dev-config-key-change-before-production-1234567890
    >> "%LOCAL_ENV%" echo PYTHON_BIN=D:\ProgramData\anaconda3\python.exe
    >> "%LOCAL_ENV%" echo ENABLE_LOCAL_IMAGE=true
    >> "%LOCAL_ENV%" echo IMAGE_PROVIDER=local
    >> "%LOCAL_ENV%" echo LOCAL_IMAGE_API_BASE_URL=http://127.0.0.1:18080/v1
    >> "%LOCAL_ENV%" echo LOCAL_IMAGE_API_KEY=local-dev-key
    >> "%LOCAL_ENV%" echo LOCAL_IMAGE_MODEL=local-cpu-safe-image
    >> "%LOCAL_ENV%" echo IMAGE_MODEL=local-cpu-safe-image
    >> "%LOCAL_ENV%" echo IMAGE_TIMEOUT_MS=600000
    >> "%LOCAL_ENV%" echo REM Ppt local mode
    >> "%LOCAL_ENV%" echo PPT_PROVIDER=local
    >> "%LOCAL_ENV%" echo ENABLE_LOCAL_PPT=true
    >> "%LOCAL_ENV%" echo LOCAL_TEXT_API_BASE_URL=http://127.0.0.1:18081/v1
    >> "%LOCAL_ENV%" echo LOCAL_TEXT_API_KEY=local-dev-key
    >> "%LOCAL_ENV%" echo LOCAL_TEXT_MODEL=local-text-mock
    >> "%LOCAL_ENV%" echo REM Text provider points to local text server (config keys take priority over db)
    >> "%LOCAL_ENV%" echo provider_base_url=http://127.0.0.1:18081/v1
    >> "%LOCAL_ENV%" echo provider_api_key=local-dev-key
    >> "%LOCAL_ENV%" echo chat_model=local-text-mock
    >> "%LOCAL_ENV%" echo ppt_model=local-text-mock
    >> "%LOCAL_ENV%" echo TIME_BACKWARD_BASE_URL=http://127.0.0.1:18081/v1
    >> "%LOCAL_ENV%" echo TIME_BACKWARD_API_KEY=local-dev-key
    >> "%LOCAL_ENV%" echo CHAT_MODEL=local-text-mock
    >> "%LOCAL_ENV%" echo PPT_MODEL=local-text-mock
    >> "%LOCAL_ENV%" echo ANTHROPIC_API_KEY=local-dev-placeholder
    >> "%LOCAL_ENV%" echo EMAIL_DEV_LOG_CODES=true
    >> "%LOCAL_ENV%" echo ALIPAY_ENABLED=false
    >> "%LOCAL_ENV%" echo OFFICE_PREVIEW_AUTO_RENDER=false
    >> "%LOCAL_ENV%" echo UNOSERVER_ENABLED=false
    >> "%LOCAL_ENV%" echo REM Debug mode: skip re-generating pages that already have SVG files (set to false to disable)
    >> "%LOCAL_ENV%" echo PPT_DEBUG_MODE=true
)

echo [1/5] Checking Node.js ...
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: Node.js was not found.
    echo Please install Node.js LTS, then run start_all.bat again.
    echo Download: https://nodejs.org/
    echo.
    echo Node.js not found >> "%LOG%"
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo Node.js: %NODE_VERSION%
echo Node.js: %NODE_VERSION% >> "%LOG%"

where npm >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: npm was not found. Please reinstall Node.js LTS.
    echo.
    echo npm not found >> "%LOG%"
    pause
    exit /b 1
)

echo.
echo [2/5] Checking image provider mode ...
set "IMAGE_PROVIDER_MODE=mock"
if exist "%LOCAL_ENV%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%LOCAL_ENV%") do (
    if /I "%%A"=="IMAGE_PROVIDER" set "IMAGE_PROVIDER_MODE=%%B"
    if /I "%%A"=="ENABLE_LOCAL_IMAGE" set "ENABLE_LOCAL_IMAGE_VALUE=%%B"
  )
)
if /I "%IMAGE_PROVIDER_MODE%"=="openai-compatible" goto SKIP_LOCAL_IMAGE_SERVER
if /I "%IMAGE_PROVIDER_MODE%"=="real-api" goto SKIP_LOCAL_IMAGE_SERVER
if /I "%IMAGE_PROVIDER_MODE%"=="openai" goto SKIP_LOCAL_IMAGE_SERVER
if /I "%IMAGE_PROVIDER_MODE%"=="localai" goto SKIP_LOCAL_IMAGE_SERVER

echo Starting offline placeholder image server on port 18080 ...
start "AIDesigner-ImageServer-18080" /d "%BASE%\local-image-server" cmd /k "chcp 65001 >nul && title AIDesigner Image Server 18080 && echo Image server starting on http://127.0.0.1:18080 && node app-node.js"
if errorlevel 1 (
    echo ERROR: failed to open image server window.
    echo Failed to start image server >> "%LOG%"
    pause
    exit /b 1
)
goto AFTER_IMAGE_PROVIDER

:SKIP_LOCAL_IMAGE_SERVER
echo Real image API mode detected: %IMAGE_PROVIDER_MODE%
echo Local placeholder image server will not be started.
echo Make sure IMAGE_BASE_URL and IMAGE_API_KEY in backend\.env.local are correct.

:AFTER_IMAGE_PROVIDER
echo.
echo [3/5] Checking PPT / text provider mode ...
set "PPT_PROVIDER_MODE=mock"
set "ENABLE_LOCAL_PPT_VALUE=true"
if exist "%LOCAL_ENV%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%LOCAL_ENV%") do (
    if /I "%%A"=="PPT_PROVIDER" set "PPT_PROVIDER_MODE=%%B"
    if /I "%%A"=="ENABLE_LOCAL_PPT" set "ENABLE_LOCAL_PPT_VALUE=%%B"
  )
)
if /I "%PPT_PROVIDER_MODE%"=="api" goto SKIP_LOCAL_TEXT_SERVER
if /I "%PPT_PROVIDER_MODE%"=="openai-compatible" goto SKIP_LOCAL_TEXT_SERVER
if /I "%PPT_PROVIDER_MODE%"=="real-api" goto SKIP_LOCAL_TEXT_SERVER
if /I "%ENABLE_LOCAL_PPT_VALUE%"=="false" goto SKIP_LOCAL_TEXT_SERVER

REM Check if Ollama is available
set "OLLAMA_FOUND=0"
where ollama >nul 2>nul
if not errorlevel 1 (
    echo Ollama CLI found. Checking service...
    curl -s http://127.0.0.1:11434/api/tags >nul 2>nul
    if not errorlevel 1 (
        set "OLLAMA_FOUND=1"
        echo Ollama service is running - text server will use it for higher quality PPT.
    ) else (
        echo Ollama installed but service not running.
        echo Start it with: ollama serve
        echo Then pull a model: ollama pull qwen3
        echo.
    )
) else (
    echo.
    echo ==================================================
    echo Ollama not found. For higher quality PPT generation,
    echo install Ollama and a Chinese-capable model:
    echo.
    echo   1. Download: https://ollama.com
    echo   2. Run: ollama pull qwen3
    echo   3. Re-run start_all.bat
    echo.
    echo For now, PPT will use template-based mock mode.
    echo ==================================================
    echo.
)

echo Starting local text generation server on port 18081 ...
if not exist "%BASE%\local-text-server\app.js" (
    echo WARNING: local-text-server\app.js not found.
    echo Local text server script missing >> "%LOG%"
    goto SKIP_LOCAL_TEXT_SERVER
)
start "AIDesigner-TextServer-18081" /d "%BASE%\local-text-server" cmd /k "chcp 65001 >nul && title AIDesigner Text Server 18081 && echo Text server starting on http://127.0.0.1:18081 && echo Mode: auto ^(Ollama if available, mock fallback^) && node app.js"
if errorlevel 1 (
    echo WARNING: failed to open text server window.
    echo Failed to start text server >> "%LOG%"
)
goto AFTER_TEXT_PROVIDER

:SKIP_LOCAL_TEXT_SERVER
echo Real text API / PPT API mode detected.
echo Local text server will not be started.
echo Make sure provider_base_url and provider_api_key in backend\.env.local are correct.

:AFTER_TEXT_PROVIDER
echo.
echo [4/5] Preparing backend dependencies ...
if not exist "%BASE%\backend\node_modules" (
    echo Installing backend packages. This may take a while.
    pushd "%BASE%\backend" >> "%LOG%" 2>&1
    call npm install >> "%LOG%" 2>&1
    if errorlevel 1 (
        popd
        echo.
        echo ERROR: npm install failed. See start_all.log.
        echo.
        pause
        exit /b 1
    )
    popd >> "%LOG%" 2>&1
) else (
    echo backend\node_modules exists, skip npm install.
)

echo.
echo [5/5] Starting backend on port 3000 ...
start "AIDesigner-Backend-3000" /d "%BASE%\backend" cmd /k "chcp 65001 >nul && title AIDesigner Backend 3000 && set ENV_FILE=%LOCAL_ENV%&& echo Backend starting on http://localhost:3000 && echo ENV_FILE=%LOCAL_ENV% && node src/index.js"
if errorlevel 1 (
    echo ERROR: failed to open backend window.
    echo Failed to start backend >> "%LOG%"
    pause
    exit /b 1
)

echo.
echo ==================================================
echo Started.
echo.
echo Windows that should remain open:
echo   1. AIDesigner Image Server 18080  ^(if local image mode^)
echo   2. AIDesigner Text Server 18081  ^(if local PPT mode^)
echo   3. AIDesigner Backend 3000
echo.
echo Open:
echo   http://localhost:3000/dashboard.html
echo   http://localhost:3000/image.html
echo   http://localhost:3000/ppt.html
echo.
echo Admin:
echo   admin@localhost
echo   AdminLocal@2026
echo.
echo If a window closes, read:
echo   %LOG%
echo ==================================================
echo.

timeout /t 5 /nobreak >nul
start "" "http://localhost:3000/dashboard.html"

pause
endlocal
