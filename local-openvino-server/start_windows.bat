@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" copy ".env.example" ".env" >nul
set "LOCAL_IMAGE_HOST=127.0.0.1"
set "LOCAL_IMAGE_PORT=18081"

if not exist ".venv\Scripts\python.exe" (
  echo Local OpenVINO server is not set up yet.
  echo Please run local-openvino-server\setup_windows.bat first.
  pause
  exit /b 1
)

echo Starting local OpenVINO image server on http://127.0.0.1:18081
echo Health: http://127.0.0.1:18081/health
echo.
call .venv\Scripts\python.exe app.py
pause
endlocal
