@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
set "BASE=%~dp0"
set "BASE=%BASE:~0,-1%"
set "LOCAL_ENV=%BASE%\backend\.env.local"

cls
echo ==================================================
echo AI Designer Lite - Debug Start
echo ==================================================
echo.
echo This window will not auto-close.
echo.

where node
node -v
where npm
npm -v

echo.
echo Testing local image server file...
if not exist "%BASE%\local-image-server\app-node.js" (
  echo ERROR: local-image-server\app-node.js not found.
  pause
  exit /b 1
)

echo.
echo Testing backend folder...
if not exist "%BASE%\backend\package.json" (
  echo ERROR: backend\package.json not found.
  pause
  exit /b 1
)

echo.
echo Starting image server in a new window...
start "AIDesigner-ImageServer-18080" /d "%BASE%\local-image-server" cmd /k "chcp 65001 >nul && node app-node.js"

echo.
echo Starting backend in this window for debugging...
cd /d "%BASE%\backend"
set "ENV_FILE=%LOCAL_ENV%"
if not exist node_modules (
  echo Installing npm packages...
  call npm install
)
echo.
echo Running npm run dev...
call npm run dev

echo.
echo Backend stopped. Error code: %ERRORLEVEL%
pause
