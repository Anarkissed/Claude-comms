#!/bin/zsh
# Double-click to start agent-comms web for this Mac AND your phone on the same home Wi-Fi.
# The Terminal shows the phone link and a 6-character pairing code. Keep this window open; close it to stop.
cd "$(dirname "$0")"
exec /usr/bin/python3 server.py --lan --open
