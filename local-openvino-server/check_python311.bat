@echo off
setlocal EnableExtensions
chcp 65001 >nul

echo Python runtimes registered in Windows py launcher:
where py >nul 2>nul
if errorlevel 1 (
  echo py.exe not found.
  exit /b 1
)
py -0p

echo.
echo Python 3.11 check:
py -3.11 -c "import sys; print('OK:', sys.executable); print(sys.version)"
exit /b %errorlevel%
