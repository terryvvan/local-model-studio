@echo off
rem Bonsai Studio launcher. ASCII only on purpose (see the project notes on
rem PowerShell 5.1 / cmd encoding traps).
title Bonsai Studio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found on PATH. Node 24 is required to run the UI server.
  pause
  exit /b 1
)
echo Starting Bonsai Studio...
echo   UI server : http://127.0.0.1:8788/
echo   Engine    : llama-server, started by the UI server
echo Close this window to stop both.
echo.
node "%~dp0server.js"
echo.
echo [Bonsai Studio] server exited.
pause
