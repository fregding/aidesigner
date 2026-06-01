@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

echo Stopping AI Designer local ports: 3000, 18080, 18081, 18082 ...
for %%P in (3000 18080 18081 18082) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    if not "%%A"=="0" (
      echo Killing PID %%A on port %%P
      taskkill /F /PID %%A >nul 2>nul
    )
  )
)
timeout /t 1 /nobreak >nul
echo Current listeners after cleanup:
netstat -ano | findstr /R /C:":3000 .*LISTENING" /C:":18080 .*LISTENING" /C:":18081 .*LISTENING" /C:":18082 .*LISTENING"
echo Done.
endlocal
