@echo off
setlocal
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0use_pollinations_ppt_api.ps1" %*
exit /b %ERRORLEVEL%
