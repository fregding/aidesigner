@echo off
setlocal EnableExtensions
set "BASE=%~dp0"
set "BASE=%BASE:~0,-1%"
set "ENV_FILE_PATH=%BASE%\backend\.env.local"

echo ==================================================
echo Repair AI Designer Lite local SD-Turbo integration
echo ==================================================
echo.

if not exist "%BASE%\backend" (
  echo ERROR: backend folder not found. Run this from project root.
  pause
  exit /b 1
)

if exist "%BASE%\scripts\stop_ai_designer_ports.bat" call "%BASE%\scripts\stop_ai_designer_ports.bat"

if exist "%ENV_FILE_PATH%" (
  copy /Y "%ENV_FILE_PATH%" "%ENV_FILE_PATH%.bak" >nul
  echo Backed up backend\.env.local to backend\.env.local.bak
)

if exist "%BASE%\backend\.env.local.SD-Turbo.clean" (
  copy /Y "%BASE%\backend\.env.local.SD-Turbo.clean" "%ENV_FILE_PATH%" >nul
  echo Rewrote backend\.env.local from clean SD-Turbo template.
) else (
  echo ERROR: backend\.env.local.SD-Turbo.clean not found.
  pause
  exit /b 1
)

if exist "%BASE%\backend\scripts\repairLocalSdTurboConfig.js" (
  pushd "%BASE%\backend"
  set "ENV_FILE=%ENV_FILE_PATH%"
  node scripts\repairLocalSdTurboConfig.js
  if errorlevel 1 (
    popd
    echo ERROR: database runtime config repair failed.
    pause
    exit /b 1
  )
  popd
)

echo.
echo Repair complete. Now run:
echo   start_all.bat
echo.
pause
endlocal
