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

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%ENV_FILE%';" ^
  "$lines=Get-Content -LiteralPath $p -ErrorAction Stop;" ^
  "$set=@{ 'ENABLE_LOCAL_IMAGE'='true'; 'IMAGE_PROVIDER'='mock'; 'LOCAL_IMAGE_API_BASE_URL'='http://127.0.0.1:18080/v1'; 'LOCAL_IMAGE_API_KEY'='local-dev-key'; 'LOCAL_IMAGE_MODEL'='local-cpu-safe-image'; 'IMAGE_MODEL'='local-cpu-safe-image' };" ^
  "foreach($k in $set.Keys){ $found=$false; $lines=$lines | ForEach-Object { if($_ -match ('^'+[regex]::Escape($k)+'=')){ $found=$true; $k+'='+$set[$k] } else { $_ } }; if(-not $found){ $lines += $k+'='+$set[$k] } };" ^
  "Set-Content -LiteralPath $p -Value $lines -Encoding UTF8"

echo Offline placeholder image mode enabled.
echo Run start_all.bat again.
pause
