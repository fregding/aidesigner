@echo off
setlocal
set "BASE=%~dp0.."
set "LOCAL_IMAGE_HOST=127.0.0.1"
set "LOCAL_IMAGE_PORT=18080"
set "LOCAL_IMAGE_API_KEY=local-dev-key"
set "LOCAL_IMAGE_MODEL_ID=local-mock-image"
set "LOCAL_IMAGE_BACKEND=mock-stdlib"
title Image Server (18080)
echo Image Server: http://127.0.0.1:18080/health
echo.
"%BASE%\local-image-server\.venv\Scripts\python.exe" "%BASE%\local-image-server\app.py"
pause
