# Claude-comms web desk

Your approval desk in a browser, and on your phone over home Wi-Fi. It's one Python file plus a page, standard library only (Python 3.9+), with the same folder and rules as the plugin.

```bash
/usr/bin/python3 server.py --open          # this Mac only: 127.0.0.1, secret key in the printed link
/usr/bin/python3 server.py --lan --open    # plus your phone: scan the QR printed in the Terminal
```

On macOS you can double-click `Agent Comms.command` or `Agent Comms (phone).command` instead. Keep the Terminal window open while you use it; closing it stops the desk.

- **Folder:** `AGENT_COMMS_ROOT`, default `~/agent-comms`.
- **Desk state:** what you've seen and held is kept in `~/.claude/agent-comms-web/state.json` (`AGENT_COMMS_WEB_STATE` to change). Use either this desk or the `/comms` pane for Hold, or a message may be announced twice.
- **Phone mode safety:** only home-network addresses (10.x, 172.16–31.x, 192.168.x) are served. Pairing takes the 6-character code (or the QR), five wrong codes lock it, and the code changes after each pairing. The key and the code live only in memory. It's plain HTTP, so use it on a home network you trust.
- **After an update:** if the page and the server don't match, the page asks you to restart the server.

Tests: `python3 -m unittest -v test_web`.
