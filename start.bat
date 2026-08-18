@echo off
title PhoneCam Pro Desktop
cd /d "%~dp0"
echo ===================================================
echo             PhoneCam Pro - Desktop App
echo ===================================================
echo Iniciando aplicacion de escritorio...
if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
) else (
    cmd /c npx electron .
)
exit
