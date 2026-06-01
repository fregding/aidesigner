@echo off
setlocal enabledelayedexpansion

echo ==================================================
echo AI Designer Lite - Fix SQLite Corrupt + Enable Real Image
echo ==================================================
echo.

set "BASE=%~dp0"
set "BASE=%BASE:~0,-1%"
set "BACKEND=%BASE%\backend"
set "DATA=%BACKEND%\data"
set "ENVFILE=%BACKEND%\.env.local"

if not exist "%BACKEND%" (
  echo ERROR: backend folder not found.
  echo Please put this .bat in the project root folder: aidesigner_lite
  pause
  exit /b 1
)

echo [1/5] Stop running Node/Nodemon processes...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM nodemon.exe >nul 2>&1

echo [2/5] Backup corrupt SQLite database if exists...
if not exist "%DATA%" mkdir "%DATA%"

set "STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%"
set "STAMP=%STAMP: =0%"

if exist "%DATA%\aimaster.db" (
  copy /Y "%DATA%\aimaster.db" "%DATA%\aimaster.db.corrupt.%STAMP%.bak" >nul
  del /F /Q "%DATA%\aimaster.db" >nul 2>&1
)

del /F /Q "%DATA%\aimaster.db-wal" >nul 2>&1
del /F /Q "%DATA%\aimaster.db-shm" >nul 2>&1

echo [3/5] Rewrite backend\.env.local to real image provider mode...

> "%ENVFILE%" echo PORT=3000
>> "%ENVFILE%" echo NODE_ENV=development
>> "%ENVFILE%" echo TRUST_PROXY=false
>> "%ENVFILE%" echo PUBLIC_UPLOADS_ENABLED=true
>> "%ENVFILE%" echo SIGNED_UPLOADS_ENABLED=false
>> "%ENVFILE%" echo DATA_DIR=./data
>> "%ENVFILE%" echo DB_PATH=./data/aimaster.db
>> "%ENVFILE%" echo UPLOAD_DIR=./uploads
>> "%ENVFILE%" echo ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
>> "%ENVFILE%" echo.
>> "%ENVFILE%" echo ADMIN_EMAIL=admin@localhost
>> "%ENVFILE%" echo ADMIN_PASSWORD=AdminLocal@2026
>> "%ENVFILE%" echo JWT_SECRET=local-dev-jwt-secret-change-before-production-1234567890
>> "%ENVFILE%" echo CONFIG_ENCRYPTION_KEY=local-dev-config-key-change-before-production-1234567890
>> "%ENVFILE%" echo.
>> "%ENVFILE%" echo ENABLE_LOCAL_IMAGE=false
>> "%ENVFILE%" echo IMAGE_PROVIDER=pollinations
>> "%ENVFILE%" echo IMAGE_BASE_URL=https://image.pollinations.ai
>> "%ENVFILE%" echo IMAGE_API_KEY=
>> "%ENVFILE%" echo IMAGE_MODEL=flux
>> "%ENVFILE%" echo IMAGE_TIMEOUT_MS=600000
>> "%ENVFILE%" echo.
>> "%ENVFILE%" echo LOCAL_IMAGE_API_BASE_URL=http://127.0.0.1:18080/v1
>> "%ENVFILE%" echo LOCAL_IMAGE_API_KEY=local-dev-key
>> "%ENVFILE%" echo LOCAL_IMAGE_MODEL=local-cpu-safe-image
>> "%ENVFILE%" echo.
>> "%ENVFILE%" echo TIME_BACKWARD_API_KEY=local-dev-placeholder
>> "%ENVFILE%" echo ANTHROPIC_API_KEY=local-dev-placeholder
>> "%ENVFILE%" echo.
>> "%ENVFILE%" echo EMAIL_DEV_LOG_CODES=true
>> "%ENVFILE%" echo ALIPAY_ENABLED=false
>> "%ENVFILE%" echo OFFICE_PREVIEW_AUTO_RENDER=false
>> "%ENVFILE%" echo UNOSERVER_ENABLED=false

echo [4/5] Done. SQLite database will be recreated on next startup.
echo.
echo [5/5] Please start the project again:
echo   start_all.bat
echo.
echo Then login again:
echo   admin@localhost
echo   AdminLocal@2026
echo.
echo Check provider:
echo   http://localhost:3000/api/ai/image-provider/status
echo.
echo If browser keeps old token, open:
echo   http://localhost:3000/reset_login_token.html
echo ==================================================
pause
endlocal
