@echo off
REM Double-click entry point: hands off to the windowless VBS launcher so no
REM console window is left sitting on the desktop.
start "" wscript.exe "%~dp0Local Model Studio.vbs"
