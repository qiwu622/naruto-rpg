@echo off
setlocal
chcp 65001 >nul
title Naruto RPG Android Debug Build
pushd "%SystemRoot%"
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-android.ps1" %*
set "NARUTO_ANDROID_EXIT=%ERRORLEVEL%"
popd
if not defined NARUTO_ANDROID_NO_PAUSE pause
exit /b %NARUTO_ANDROID_EXIT%
