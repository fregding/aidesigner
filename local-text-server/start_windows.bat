@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
set "LOCAL_TEXT_HOST=127.0.0.1"
set "LOCAL_TEXT_PORT=18082"
set "TEXT_SERVER_PORT=18082"
set "LOCAL_TEXT_MODEL=local-text-mock"
echo Text server starting on http://127.0.0.1:18082
echo Mode: mock/OpenAI-compatible local text endpoint
node app.js
pause
endlocal
