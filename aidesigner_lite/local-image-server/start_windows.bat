@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
echo Starting AI Designer local image server...
echo URL: http://127.0.0.1:18080
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found. Please install Node.js LTS.
  pause
  exit /b 1
)
node app-node.js
pause
