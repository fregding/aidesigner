@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "PY_CMD="
where py >nul 2>nul
if not errorlevel 1 (
  py -3.11 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)" >nul 2>nul
  if not errorlevel 1 set "PY_CMD=py -3.11"
  if not defined PY_CMD (
    py -3.10 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 set "PY_CMD=py -3.10"
  )
)
if not defined PY_CMD (
  where python >nul 2>nul
  if not errorlevel 1 (
    python -c "import sys; raise SystemExit(0 if sys.version_info[:2] in [(3,10),(3,11)] else 1)" >nul 2>nul
    if not errorlevel 1 set "PY_CMD=python"
  )
)

if not defined PY_CMD (
  echo ERROR: This local OpenVINO server requires Python 3.10 or 3.11.
  echo Your system default Python can remain 3.12; install Python 3.11 side-by-side.
  echo Then run this script again.
  pause
  exit /b 1
)

echo ==================================================
echo Setup local OpenVINO image server
echo This script does NOT change your system default Python.
echo It only creates/updates local-openvino-server\.venv.
echo Using Python command: %PY_CMD%
echo ==================================================
echo.

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created local-openvino-server\.env from .env.example
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  %PY_CMD% -m venv .venv
  if errorlevel 1 (
    echo ERROR: failed to create virtual environment.
    pause
    exit /b 1
  )
)

echo Checking virtual environment Python version...
call .venv\Scripts\python.exe -c "import sys; print('Python', sys.version); raise SystemExit(0 if sys.version_info[:2] in [(3,10),(3,11)] else 1)"
if errorlevel 1 (
  echo.
  echo ERROR: Existing .venv was created with an unsupported Python version.
  echo Delete local-openvino-server\.venv, install Python 3.10/3.11, then run this script again.
  pause
  exit /b 1
)

echo Upgrading pip/setuptools/wheel...
call .venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto PIP_FAIL

echo Installing PyTorch CPU 2.8.0 first to avoid torch 2.9 / optimum incompatibility...
call .venv\Scripts\python.exe -m pip install --upgrade --force-reinstall torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 goto TORCH_FAIL

echo Verifying PyTorch / optimum ONNX compatibility symbol...
call .venv\Scripts\python.exe -c "from torch.onnx.symbolic_opset14 import _attention_scale; import torch; print('Torch OK:', torch.__version__)"
if errorlevel 1 goto TORCH_FAIL

echo Installing remaining dependencies with prebuilt wheels where it matters...
call .venv\Scripts\python.exe -m pip install --prefer-binary --only-binary=numpy,pillow,openvino -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto PIP_FAIL

echo.
echo Setup completed.
echo Test with: http://127.0.0.1:18081/health?load=true after starting the server.
echo.
pause
exit /b 0

:TORCH_FAIL
echo.
echo ERROR: failed to install/verify torch==2.8.0 CPU.
echo This usually means the PyTorch CPU wheel index is unreachable.
echo Try again with a better network, then rerun this script.
echo.
pause
exit /b 1

:PIP_FAIL
echo.
echo ERROR: pip install failed.
echo Common fixes:
echo   1. Keep your system Python 3.12 if needed, but this .venv must use Python 3.10/3.11.
echo   2. Delete local-openvino-server\.venv and run this script again.
echo   3. If your network blocks the mirror, remove the -i mirror line or switch to another PyPI mirror.
echo.
pause
exit /b 1
