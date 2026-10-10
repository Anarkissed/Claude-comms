#!/bin/zsh
# Double-click to start agent-comms web; it opens the page in your browser.
# Keep this window open while you use it; close it to stop.
cd "$(dirname "$0")"
exec /usr/bin/python3 server.py --open
