@echo off
setlocal
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules;%ProgramFiles%\WindowsPowerShell\Modules"
chcp 65001 >nul
pushd "%SystemRoot%"
if errorlevel 1 exit /b 1
echo ========================================
echo   忍者手记 - 一键部署到测试站
echo ========================================
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Mode staging %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
if "%DEPLOY_EXIT%"=="0" goto deploy_success
if not defined DEPLOY_EXIT set "DEPLOY_EXIT=1"
echo 测试站部署失败，错误码：%DEPLOY_EXIT%
if not defined NARUTO_DEPLOY_NO_PAUSE pause
popd
exit /b %DEPLOY_EXIT%

:deploy_success
echo 测试站部署成功。
if not defined NARUTO_DEPLOY_NO_PAUSE pause
popd
exit /b 0
