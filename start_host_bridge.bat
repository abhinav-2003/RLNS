@echo off
title RLNS Host Oracle Bridge (Port 3005)
cd /d "%~dp0"
echo ============================================================
echo   RLNS Host Oracle Bridge
echo   Connecting to Oracle DB 10.2.53.55:1521 via SQL*Plus
echo   Listening on http://0.0.0.0:3005 for Docker Backend
echo ============================================================
:loop
"C:\Program Files\nodejs\node.exe" host_bridge.js
echo [Notice] Host bridge exited (%ERRORLEVEL%). Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
