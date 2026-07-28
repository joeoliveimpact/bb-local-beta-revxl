@echo off
setlocal
title Booking Bandit - Local Engine Installer
echo ============================================================
echo   Booking Bandit - Local Engine Setup (Windows)
echo ============================================================
echo.
echo This registers the Booking Bandit helper so Chrome can use
echo your local Claude. No typing needed - just wait for it to finish.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-engine\install\install-windows.ps1" -ExtensionId eoaibojoneilhiagjmmhbbgehnmloelj -Browser all
echo.
echo ============================================================
if %ERRORLEVEL%==0 (
  echo   DONE. If you see "SMOKE PASS" above, setup worked.
  echo   Next: FULLY quit Chrome ^(close every window^) and reopen it,
  echo   then open Booking Bandit ^> Settings ^> Key ^> "Test local engine".
) else (
  echo   SETUP HIT A PROBLEM. Send Joe a screenshot of this window.
)
echo ============================================================
echo.
pause
