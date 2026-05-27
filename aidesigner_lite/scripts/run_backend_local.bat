@echo off
setlocal
set "BASE=%~dp0.."
set "ENV_FILE=%BASE%\backend\.env.local"
set "NODE_ENV=development"
set "PORT=3000"
set "FRONTEND_ROOT=%BASE%"
set "ENABLE_LOCAL_IMAGE=true"
set "IMAGE_PROVIDER=local"
set "LOCAL_IMAGE_API_BASE_URL=http://127.0.0.1:18080/v1"
set "LOCAL_IMAGE_API_KEY=local-dev-key"
set "LOCAL_IMAGE_MODEL=local-mock-image"
title Backend (3000)
echo Backend: http://localhost:3000
echo ENV_FILE: %ENV_FILE%
echo.
cd /d "%BASE%\backend"
npm run dev
pause
