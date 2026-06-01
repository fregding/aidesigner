@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "BASE=%~dp0"
set "ENV_FILE=%BASE%backend\.env.local"

cls
echo ==================================================
echo Configure Real Image API - Stage 1
echo ==================================================
echo.
echo This script switches image generation from offline placeholder
echo to a real OpenAI-compatible image API.
echo.
echo Examples:
echo   LocalAI:   http://127.0.0.1:8080/v1
echo   Any API:   https://your-provider.example/v1
echo.
echo The provider must support:
echo   POST /v1/images/generations
echo returning:
echo   { "data": [ { "b64_json": "..." } ] }
echo.

if not exist "%ENV_FILE%" (
  echo ERROR: backend\.env.local not found. Run start_all.bat once first.
  pause
  exit /b 1
)

set /p "API_BASE=Image API Base URL: "
if "%API_BASE%"=="" (
  echo Cancelled.
  pause
  exit /b 1
)

set /p "API_KEY=Image API Key: "
if "%API_KEY%"=="" (
  echo API key is empty. For some local services you can type any value, for example local-key.
  set /p "API_KEY=Image API Key: "
)

set /p "MODEL=Image model name [gpt-image-1]: "
if "%MODEL%"=="" set "MODEL=gpt-image-1"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%ENV_FILE%';" ^
  "$lines=Get-Content -LiteralPath $p -ErrorAction Stop;" ^
  "$set=@{ 'ENABLE_LOCAL_IMAGE'='false'; 'IMAGE_PROVIDER'='openai-compatible'; 'IMAGE_BASE_URL'='%API_BASE%'; 'IMAGE_API_KEY'='%API_KEY%'; 'IMAGE_MODEL'='%MODEL%'; 'REAL_IMAGE_API_BASE_URL'='%API_BASE%'; 'REAL_IMAGE_API_KEY'='%API_KEY%'; 'REAL_IMAGE_MODEL'='%MODEL%' };" ^
  "foreach($k in $set.Keys){ $found=$false; $lines=$lines | ForEach-Object { if($_ -match ('^'+[regex]::Escape($k)+'=')){ $found=$true; $k+'='+$set[$k] } else { $_ } }; if(-not $found){ $lines += $k+'='+$set[$k] } };" ^
  "Set-Content -LiteralPath $p -Value $lines -Encoding UTF8"

echo.
echo Done. Real image API mode enabled.
echo.
echo Next:
echo   1. Close old backend window.
echo   2. Run start_all.bat again.
echo   3. Open http://localhost:3000/api/ai/image-provider/status after login is not required only via browser with auth not available; use app to generate image.
echo.
pause
