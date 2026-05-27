@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "BASE=%~dp0"
set "ENV_FILE=%BASE%backend\.env.local"

if not exist "%ENV_FILE%" (
  echo backend\.env.local not found.
  pause
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  if /I "%%A"=="IMAGE_BASE_URL" set "IMAGE_BASE_URL=%%B"
  if /I "%%A"=="IMAGE_API_KEY" set "IMAGE_API_KEY=%%B"
  if /I "%%A"=="IMAGE_MODEL" set "IMAGE_MODEL=%%B"
)

if "%IMAGE_BASE_URL%"=="" (
  echo IMAGE_BASE_URL is empty. Run configure_real_image_api.bat first.
  pause
  exit /b 1
)

echo Testing:
echo   %IMAGE_BASE_URL%/images/generations
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$body=@{model='%IMAGE_MODEL%';prompt='a cute cat, watercolor style';size='512x512';n=1} | ConvertTo-Json;" ^
  "$headers=@{Authorization='Bearer %IMAGE_API_KEY%';'Content-Type'='application/json'};" ^
  "try { $r=Invoke-RestMethod -Method Post -Uri ('%IMAGE_BASE_URL%/images/generations') -Headers $headers -Body $body -TimeoutSec 180; $r | ConvertTo-Json -Depth 6; } catch { Write-Host 'ERROR:' $_.Exception.Message; if($_.ErrorDetails.Message){ Write-Host $_.ErrorDetails.Message } }"

pause
