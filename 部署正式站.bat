@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules;%ProgramFiles%\WindowsPowerShell\Modules"
chcp 65001 >nul
pushd "%SystemRoot%"
if errorlevel 1 exit /b 1
echo ========================================
echo   忍者手记 - 一键部署到正式站
echo ========================================
echo.
echo 警告：此操作会更新正式站并重启正式后端。
echo.
echo 按任意键开始部署，或关闭窗口取消...
if not defined NARUTO_DEPLOY_NO_PAUSE pause >nul
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Mode production -ConfirmProduction %*
set "DEPLOY_EXIT=!ERRORLEVEL!"
echo.
if "!DEPLOY_EXIT!"=="0" goto deploy_success
echo 正式站部署失败，错误码：!DEPLOY_EXIT!
if not defined NARUTO_DEPLOY_NO_PAUSE pause
popd
exit /b !DEPLOY_EXIT!

:deploy_success
echo 正式站部署成功。
if not defined NARUTO_DEPLOY_NO_PAUSE pause
popd
exit /b 0
