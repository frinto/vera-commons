@echo off
title Agent Commons Console
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ============================================================
  echo    Node.js is not installed on this computer.
  echo.
  echo    Install it once from  https://nodejs.org
  echo    Click the big green "LTS" button, run the installer,
  echo    click Next through everything, then run this file again.
  echo   ============================================================
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the Agent Commons Console...
echo   A browser window should open by itself in a moment.
echo.
node app.mjs

echo.
echo   The console has stopped.
pause
