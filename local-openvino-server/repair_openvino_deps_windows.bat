@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "VENV_DIR=local-openvino-server\.venv"
set "PYTHON=%VENV_DIR%\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo [ERROR] 虚拟环境未找到: %VENV_DIR%
    echo 请先运行 setup_windows.bat 创建环境。
    pause
    exit /b 1
)

echo ==================================================
echo 修复 NNCF 版本兼容性问题
echo 目标: nncf==2.7.0（与 optimum-intel 兼容）
echo ==================================================
echo.

echo 当前 Python 环境:
call "%PYTHON%" -c "import sys; print(sys.executable); print(sys.version)"
if errorlevel 1 goto :FAIL

echo.
echo 检查并安装兼容的 nncf 版本...
:: 如果已安装 2.7.0，pip 会提示 "Requirement already satisfied" 并跳过
call "%PYTHON%" -m pip install nncf==2.7.0
if errorlevel 1 goto :FAIL

echo.
echo 验证修复结果...
call "%PYTHON%" -c "from nncf import NNCFConfig; print('NNCFConfig 导入成功')"
if errorlevel 1 (
    echo [FAIL] 导入 NNCFConfig 仍然失败，可能需要同步调整 optimum-intel 版本。
    goto :FAIL
) else (
    echo [OK] NNCFConfig 导入正常。
)

echo.
echo ==================================================
echo 修复完成！请重启 OpenVINO 服务:
echo   local-openvino-server\start_windows.bat
echo ==================================================
pause
exit /b 0

:FAIL
echo.
echo [ERROR] 修复过程中出现错误，请检查上面的输出。
pause
exit /b 1