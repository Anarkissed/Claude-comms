#!/usr/bin/env python3
"""agent-comms web: the maintainer's /comms pane as a page in your browser.

    /usr/bin/python3 server.py [--port 8765] [--open] [--lan]

Standard library only.

Without --lan it listens on 127.0.0.1 alone, and every request needs the
secret key printed (with the link) in the Terminal that started it, as
Jupyter does: a coding agent, or a web page in your browser, cannot reach it
without that key.

With --lan your phone can use it over your home Wi-Fi too:
  - it also listens on the Mac's network address, but answers only devices
    with a private home-network address (192.168.x, 10.x, 172.16-31.x), so
    nothing from the internet is served even if a router forwarded the port;
  - the phone pairs once: it opens http://<mac>:<port>/phone and types the
    6-character code shown only on the Mac (Terminal and the Mac's page);
    five wrong codes lock pairing until the server restarts;
  - the key and the code live in this process's memory only, never on disk,
    so an agent on the Mac cannot read them from a file.
  Plain HTTP: traffic on your Wi-Fi between phone and Mac is not encrypted.

It reads and writes the same agent-comms folder with the same rules as the
Claude Code mod (comms_core.py). Its own state (what you have seen, what you
put on hold) is kept in ~/.claude/agent-comms-web/state.json.
"""

import ipaddress
import json
import os
import secrets
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import comms_core as core  # noqa: E402
import qr  # noqa: E402

MAX_BODY = 1_000_000
# Bumped with every change to the page/server pair; the page compares it and asks for a restart when they differ.
SERVER_VERSION = "2026-10-14.3"
CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # no 0/O, 1/I: easy to type on a phone
MAX_PAIR_FAILURES = 5
COOKIE = "comms_session"

SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}
PAGE_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"


def lan_address() -> Optional[str]:
    """The Mac's address on the home network: the source address the OS would
    pick for a private destination (a UDP connect sends no packet)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.168.0.1", 9))
        ip = probe.getsockname()[0]
        return ip if is_home_client(ip) and not ipaddress.ip_address(ip).is_loopback else None
    except OSError:
        return None
    finally:
        probe.close()


# Home-network ranges only (RFC 1918 and IPv6 unique-local), named outright: Python's is_private
# also counts reserved ranges such as 203.0.113.0/24 and 100.64.0.0/10, which are not a home network.
HOME_NETWORKS = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")]


def is_home_client(ip: str) -> bool:
    """This Mac, or an address on a home network; never a public one."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if address.version == 6 and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_loopback or any(address in net for net in HOME_NETWORKS if net.version == address.version)


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))


class Pairing:
    """The phone's code: shown on the Mac (as text and as a QR), typed or scanned on the phone.
    It changes after every successful pairing, so a photo of an old QR pairs nothing."""

    def __init__(self, on_paired=None) -> None:
        self.code = new_code()
        self.failures = 0
        self.lock = threading.Lock()
        self.on_paired = on_paired

    def attempt(self, given: str) -> str:
        with self.lock:
            if self.failures >= MAX_PAIR_FAILURES:
                return "locked"
            if secrets.compare_digest(given.strip().upper().replace(" ", "").replace("-", ""), self.code):
                self.code = new_code()
                if self.on_paired is not None:
                    self.on_paired(self.code)
                return "ok"
            self.failures += 1
            return "locked" if self.failures >= MAX_PAIR_FAILURES else "wrong"


PHONE_PAGE = b"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Comms</title>
<style>
 :root{--bg:#fff;--ink:#1d1d1f;--dim:#86868b;--line:#e5e5ea;--blue:#0a84ff;--bad:#ff3b30}
 @media (prefers-color-scheme:dark){:root{--bg:#000;--ink:#f5f5f7;--dim:#8e8e93;--line:#2c2c2e;--bad:#ff453a}}
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.4 -apple-system,system-ui,sans-serif}
 main{width:min(340px,90vw);text-align:center}
 h1{font-size:24px;margin:0 0 6px} p{color:var(--dim);margin:0 0 22px}
 input{width:100%;box-sizing:border-box;font:600 28px ui-monospace,monospace;letter-spacing:8px;text-align:center;text-transform:uppercase;
  padding:12px;border:1px solid var(--line);border-radius:14px;background:transparent;color:var(--ink)}
 button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:14px;background:var(--blue);color:#fff;font:600 17px -apple-system,system-ui,sans-serif}
 .err{color:var(--bad);min-height:1.4em;margin-top:12px;font-size:14px}
</style></head><body><main>
<h1>&#128236; Agent Comms</h1><p>Type the 6-character code shown on your Mac.</p>
<input id="code" maxlength="7" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" inputmode="text" autofocus>
<button id="go">Pair this phone</button><div class="err" id="err"></div>
<script>
 const go = async () => {
   const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('code').value }) })
   const j = await r.json().catch(() => ({}))
   if (j.ok) location.replace('/')
   else document.getElementById('err').textContent = j.error || 'That did not work.'
 }
 document.getElementById('go').onclick = go
 document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') go() })
 // scanned from the QR: the code rides in the link; take it out of the address bar, then pair
 const fromQr = new URLSearchParams(location.search).get('c')
 if (fromQr) { history.replaceState(null, '', '/phone'); document.getElementById('code').value = fromQr; go() }
</script></main></body></html>"""


def make_handler(folder: core.Folder, token: str, port_box: Dict[str, int], lan: Optional[Dict[str, Any]] = None):
    """lan, when given: {"hosts": [names the page may be reached by], "pairing": Pairing, "url": phone link}."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "agent-comms-web"

        def log_message(self, fmt: str, *args: Any) -> None:  # quiet: no request log in the Terminal
            return

        # ---- guards
        def _client_ok(self) -> bool:
            ip = self.client_address[0]
            return is_home_client(ip) if lan else ipaddress.ip_address(ip).is_loopback

        def _host_ok(self) -> bool:
            # a page served from elsewhere that resolves to this machine (DNS rebinding) carries its own Host
            host = (self.headers.get("Host") or "").lower()
            port = port_box["port"]
            names: List[str] = ["127.0.0.1", "localhost"] + (lan["hosts"] if lan else [])
            return host in {f"{n.lower()}:{port}" for n in names}

        def _cookie(self) -> Optional[str]:
            for part in (self.headers.get("Cookie") or "").split(";"):
                name, _, value = part.strip().partition("=")
                if name == COOKIE:
                    return value
            return None

        def _key_ok(self, given: Optional[str]) -> bool:
            return given is not None and secrets.compare_digest(given, token)

        def _authed(self) -> bool:
            # the Mac's page sends the key as a header; a paired phone carries it as a cookie
            return self._key_ok(self.headers.get("X-Comms-Token")) or self._key_ok(self._cookie())

        def _send(self, status: int, body: bytes, content_type: str, extra: Optional[Dict[str, str]] = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for name, value in {**SECURITY_HEADERS, **(extra or {})}.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, value: Any, extra: Optional[Dict[str, str]] = None) -> None:
            # ASCII escapes: a lone surrogate read from a file (half an emoji) cannot make the encode fail
            self._send(status, json.dumps(value, ensure_ascii=True).encode("ascii"), "application/json; charset=utf-8", extra)

        def _read_json(self) -> Optional[Dict[str, Any]]:
            if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
                return None
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return None
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except ValueError:
                return None
            return body if isinstance(body, dict) else None

        # ---- routes
        def do_GET(self) -> None:  # noqa: N802
            if not self._client_ok() or not self._host_ok():
                return self._send(403, b"forbidden", "text/plain")
            url = urlparse(self.path)
            if url.path == "/":
                given = parse_qs(url.query).get("t", [None])[0]
                if not (self._key_ok(given) or self._key_ok(self._cookie())):
                    if lan:  # a phone that has not paired yet
                        return self._send(302, b"", "text/plain", {"Location": "/phone"})
                    return self._send(403, b"Open the link printed in the Terminal window that started agent-comms web.", "text/plain; charset=utf-8")
                with open(os.path.join(HERE, "index.html"), "rb") as handle:
                    page = handle.read()
                return self._send(200, page, "text/html; charset=utf-8", {"Content-Security-Policy": PAGE_CSP})
            if url.path == "/phone" and lan:
                return self._send(200, PHONE_PAGE, "text/html; charset=utf-8", {"Content-Security-Policy": PAGE_CSP})
            if url.path == "/api/state":
                if not self._authed():
                    return self._json(403, {"ok": False, "error": "bad key"})
                snapshot = folder.snapshot()
                snapshot["server_version"] = SERVER_VERSION
                # the phone link and code: for the Mac's page (key in a header) only, never to a phone
                if lan and self._key_ok(self.headers.get("X-Comms-Token")):
                    code = lan["pairing"].code
                    snapshot["phone"] = {
                        "url": lan["url"],
                        "code": code,
                        "locked": lan["pairing"].failures >= MAX_PAIR_FAILURES,
                        "qr": qr.rows(qr.encode(f"{lan['url']}?c={code}")),
                    }
                return self._json(200, snapshot)
            return self._send(404, b"not found", "text/plain")

        def do_POST(self) -> None:  # noqa: N802
            if not self._client_ok() or not self._host_ok():
                return self._json(403, {"ok": False, "error": "forbidden"})
            path = urlparse(self.path).path
            body = self._read_json()
            if body is None:
                return self._json(415, {"ok": False, "error": "send JSON"})
            if path == "/api/pair" and lan:
                result = lan["pairing"].attempt(str(body.get("code", "")))
                if result == "ok":
                    cookie = f"{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
                    return self._json(200, {"ok": True}, {"Set-Cookie": cookie})
                if result == "locked":
                    print("agent-comms web: phone pairing LOCKED after 5 wrong codes; restart the server to pair again.", flush=True)
                    return self._json(403, {"ok": False, "error": "Too many wrong codes. Restart Agent Comms on the Mac to pair again."})
                return self._json(403, {"ok": False, "error": "Wrong code. Check the code on your Mac."})
            if not self._authed():
                return self._json(403, {"ok": False, "error": "forbidden"})
            ch, mid = str(body.get("channel", "")), str(body.get("id", ""))
            try:
                if path == "/api/approve":
                    info = folder.approve(ch, mid)
                elif path == "/api/hold":
                    info = folder.hold(ch, mid)
                elif path == "/api/decline":
                    info = folder.decline(ch, mid, str(body.get("reason", "")))
                elif path == "/api/post":
                    info = folder.post(ch, str(body.get("to", "")), str(body.get("kind", "note")), str(body.get("text", "")))
                elif path == "/api/group":
                    agents = body.get("agents", [])
                    info = folder.create_group(str(body.get("name", "")), [str(a) for a in agents] if isinstance(agents, list) else [])
                elif path == "/api/settings":
                    info = folder.set_reviewer_mode(str(body.get("reviewer_mode", "")))
                elif path == "/api/direct":
                    info = folder.ensure_direct()
                elif path == "/api/seen":
                    folder.mark_seen(ch)
                    info = ""
                else:
                    return self._json(404, {"ok": False, "error": "not found"})
            except (OSError, ValueError) as error:
                return self._json(500, {"ok": False, "error": str(error)})
            return self._json(200, {"ok": True, "info": info})

    return Handler


def serve(folder: core.Folder, port: int, token: str, lan: bool = False) -> ThreadingHTTPServer:
    """Binds 127.0.0.1, or every interface with --lan (the handler still refuses non-home clients)."""
    bind = "0.0.0.0" if lan else "127.0.0.1"
    port_box = {"port": port}
    for candidate in range(port, port + 20):
        try:
            port_box["port"] = candidate
            return ThreadingHTTPServer((bind, candidate), make_handler(folder, token, port_box))
        except OSError:
            continue
    raise SystemExit(f"no free port between {port} and {port + 19}")


def prepare_console() -> None:
    """Windows: turn on colour codes in the console (the QR is drawn with them), and never let a
    character the console cannot show (the emoji) stop the server."""
    if os.name == "nt":
        os.system("")  # enables VT processing in the classic Windows console
    try:
        sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass


def main(argv: list) -> int:
    prepare_console()
    port = 8765
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    use_lan = "--lan" in argv
    home = os.path.expanduser("~")
    root = os.path.expanduser(os.environ.get("AGENT_COMMS_ROOT", os.path.join(home, "agent-comms")))
    state = os.path.expanduser(os.environ.get("AGENT_COMMS_WEB_STATE", os.path.join(home, ".claude", "agent-comms-web", "state.json")))
    folder = core.Folder(root, state)
    token = secrets.token_urlsafe(24)
    httpd = serve(folder, port, token, lan=use_lan)
    real_port = httpd.server_address[1]
    port_box = {"port": real_port}
    lan_info = None
    if use_lan:
        ip = lan_address()
        hostname = socket.gethostname()
        names = [n for n in {ip, hostname, hostname if hostname.endswith(".local") else f"{hostname}.local"} if n]
        if ip is None:
            print("agent-comms web: could not find this Mac's home-network address; the phone may not reach it.", flush=True)
        phone_host = ip or (hostname if hostname.endswith(".local") else f"{hostname}.local")
        phone_url = f"http://{phone_host}:{real_port}/phone"

        def show_qr(code: str, heading: str) -> None:
            print("")
            print(heading)
            print(qr.terminal(qr.encode(f"{phone_url}?c={code}")))
            print(f"Or open {phone_url} and type the code: {code}", flush=True)

        pairing = Pairing(on_paired=lambda code: show_qr(code, "📱 A phone paired. To pair another device, scan this new code:"))
        lan_info = {"hosts": names, "pairing": pairing, "url": phone_url, "show_qr": show_qr}
    httpd.RequestHandlerClass = make_handler(folder, token, port_box, lan_info)
    url = f"http://127.0.0.1:{real_port}/?t={token}"
    print("agent-comms web is running. Keep this window open; close it (or press Ctrl+C) to stop.")
    print(f"Folder:  {root}")
    print(f"On this Mac: {url}")
    if lan_info:
        lan_info["show_qr"](lan_info["pairing"].code, "📱 On your phone (same Wi-Fi): scan this with the camera to pair and open Agent Comms.")
        print("(If macOS asks whether Python may accept incoming connections, click Allow.)")
    sys.stdout.flush()
    if "--open" in argv:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
