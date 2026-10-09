@echo off
REM Local Model Studio -- console launcher.
REM Use this one when something goes wrong: unlike the windowless .vbs, it keeps a
REM console open so you can actually read the startup errors.
cd /d "%~dp0"
echo Starting Local Model Studio (console mode)...
echo.
node app\launch.js
echo.
echo (launcher exited with code %ERRORLEVEL%)
pause
