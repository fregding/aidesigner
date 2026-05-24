@echo off
setlocal
cd /d %~dp0\..
echo [AI Designer Local] starting local image server on 127.0.0.1:18080 ...
start "AI Designer Local Image Server" cmd /k "cd /d %CD%\local-image-server && start_local_image_server.bat"
echo [AI Designer Local] starting backend on http://localhost:3000 ...
cd backend
if not exist node_modules (
  echo Installing backend dependencies...
  npm install
)
npm run init-db
npm start
