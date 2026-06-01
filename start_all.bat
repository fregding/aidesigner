@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "BASE=%~dp0"
set "BASE=%BASE:~0,-1%"
set "LOG=%BASE%\start_all.log"
set "LOCAL_ENV=%BASE%\backend\.env.local"

> "%LOG%" echo ==================================================
>> "%LOG%" echo AI Designer Lite start log
>> "%LOG%" echo Time: %DATE% %TIME%
>> "%LOG%" echo Base: %BASE%
>> "%LOG%" echo ==================================================

cls
echo ==================================================
echo AI Designer Lite - One Click Start
echo ==================================================
echo.
echo Base directory:
echo %BASE%
echo.

if not exist "%BASE%\backend" (
    echo ERROR: backend folder not found. Please run this script from project root.
    pause
    exit /b 1
)

if not exist "%LOCAL_ENV%" (
    echo Creating backend\.env.local from clean SD-Turbo template ...
    if exist "%BASE%\backend\.env.local.SD-Turbo.clean" (
        copy /Y "%BASE%\backend\.env.local.SD-Turbo.clean" "%LOCAL_ENV%" >nul
    ) else (
        echo ERROR: backend\.env.local is missing and clean template was not found.
        pause
        exit /b 1
    )
)

echo [1/5] Checking Node.js ...
where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found. Please install Node.js LTS.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo Node.js: %NODE_VERSION%
where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found. Please reinstall Node.js LTS.
    pause
    exit /b 1
)

echo.
echo [2/5] Checking image provider mode ...
set "IMAGE_PROVIDER_MODE=mock"
set "IMAGE_BASE_URL_VALUE="
if exist "%LOCAL_ENV%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%LOCAL_ENV%") do (
    if /I "%%A"=="IMAGE_PROVIDER" set "IMAGE_PROVIDER_MODE=%%B"
    if /I "%%A"=="IMAGE_BASE_URL" set "IMAGE_BASE_URL_VALUE=%%B"
  )
)

set "START_OPENVINO_SERVER=false"
if /I "%IMAGE_PROVIDER_MODE%"=="local-openvino" set "START_OPENVINO_SERVER=true"
if /I "%IMAGE_PROVIDER_MODE%"=="openvino" set "START_OPENVINO_SERVER=true"
if /I "%IMAGE_PROVIDER_MODE%"=="sd-turbo-local" set "START_OPENVINO_SERVER=true"
echo %IMAGE_BASE_URL_VALUE% | findstr /I "127.0.0.1:18081 localhost:18081" >nul 2>nul
if not errorlevel 1 set "START_OPENVINO_SERVER=true"

if /I "%START_OPENVINO_SERVER%"=="true" goto START_OPENVINO_IMAGE_SERVER
if /I "%IMAGE_PROVIDER_MODE%"=="openai-compatible" goto SKIP_LOCAL_IMAGE_SERVER
if /I "%IMAGE_PROVIDER_MODE%"=="real-api" goto SKIP_LOCAL_IMAGE_SERVER
if /I "%IMAGE_PROVIDER_MODE%"=="openai" goto SKIP_LOCAL_IMAGE_SERVER
if /I "%IMAGE_PROVIDER_MODE%"=="localai" goto SKIP_LOCAL_IMAGE_SERVER

echo Starting offline placeholder image server on port 18080 ...
netstat -ano | findstr /R /C:":18080 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo Port 18080 is already in use. Skip starting placeholder image server.
) else (
    start "AIDesigner-ImageServer-18080" /d "%BASE%\local-image-server" cmd /k "title AIDesigner Image Server 18080 & echo Image server starting on http://127.0.0.1:18080 & node app-node.js"
)
goto AFTER_IMAGE_PROVIDER

:START_OPENVINO_IMAGE_SERVER
echo Local OpenVINO SD-Turbo image mode detected.
if not exist "%BASE%\local-openvino-server\start_windows.bat" (
    echo ERROR: local-openvino-server\start_windows.bat not found.
    echo Copy local-openvino-server from aidesigner_lite_SD-Turbo first.
    pause
    exit /b 1
)
netstat -ano | findstr /R /C:":18081 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo Port 18081 is already in use. Skip starting OpenVINO image server.
) else (
    echo Starting local OpenVINO image server on port 18081 ...
    start "AIDesigner-OpenVINO-ImageServer-18081" /d "%BASE%\local-openvino-server" cmd /k "title AIDesigner OpenVINO Image Server 18081 & call start_windows.bat"
)
goto AFTER_IMAGE_PROVIDER

:SKIP_LOCAL_IMAGE_SERVER
echo Real image API mode detected: %IMAGE_PROVIDER_MODE%
echo Local image server will not be started.

:AFTER_IMAGE_PROVIDER

echo.
echo [3/5] Checking PPT / text provider mode ...
set "PPT_PROVIDER_MODE=local"
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

where ollama >nul 2>nul
if errorlevel 1 (
    echo Ollama not found. PPT will use local mock text mode on port 18082.
) else (
    echo Ollama CLI found. Local text server may use Ollama if its implementation supports it.
)

if not exist "%BASE%\local-text-server\start_windows.bat" (
    echo ERROR: local-text-server\start_windows.bat not found.
    pause
    exit /b 1
)
netstat -ano | findstr /R /C:":18082 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo Port 18082 is already in use. Skip starting local text server.
) else (
    echo Starting local text generation server on port 18082 ...
    start "AIDesigner-TextServer-18082" /d "%BASE%\local-text-server" cmd /k "title AIDesigner Text Server 18082 & call start_windows.bat"
)
goto AFTER_TEXT_PROVIDER

:SKIP_LOCAL_TEXT_SERVER
echo Real text API / PPT API mode detected. Local text server will not be started.

:AFTER_TEXT_PROVIDER

echo.
echo [4/5] Preparing backend dependencies ...
if not exist "%BASE%\backend\node_modules" (
    echo Installing backend packages. This may take a while.
    pushd "%BASE%\backend" >> "%LOG%" 2>&1
    call npm install >> "%LOG%" 2>&1
    if errorlevel 1 (
        popd
        echo ERROR: npm install failed. See start_all.log.
        pause
        exit /b 1
    )
    popd >> "%LOG%" 2>&1
) else (
    echo backend\node_modules exists, skip npm install.
)

echo.
echo [5/5] Starting backend on port 3000 ...
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo Port 3000 is already in use. Skip starting backend.
) else (
    start "AIDesigner-Backend-3000" /d "%BASE%\backend" cmd /k "title AIDesigner Backend 3000 & set ENV_FILE=%LOCAL_ENV%& echo Backend starting on http://localhost:3000 & echo ENV_FILE=%LOCAL_ENV% & node src/index.js"
)

echo.
echo ==================================================
echo Started or already running.
echo Expected ports:
echo   18081 OpenVINO image server
echo   18082 local text server
echo   3000  backend
echo.
echo Open: http://localhost:3000/dashboard.html
echo If startup windows show errors, run repair_all_local_sd_turbo.bat first.
echo ==================================================
echo.

pause
endlocal
