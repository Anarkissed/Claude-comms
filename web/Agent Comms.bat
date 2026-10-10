@echo off
rem Double-click to start agent-comms web; it opens the page in your browser.
rem Keep this window open while you use it; close it to stop.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 server.py --open) else (python server.py --open)
pause
