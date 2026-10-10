@echo off
rem Double-click to start agent-comms web for this PC AND your phone on the same home Wi-Fi.
rem Keep this window open while you use it; close it to stop.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 server.py --lan --open) else (python server.py --lan --open)
pause
