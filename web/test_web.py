"""Tests for agent-comms web: /usr/bin/python3 -m unittest -v test_web"""

import http.client
import json
import os
import tempfile
import threading
import unittest

import comms_core as core
import qr
import server

CONFIG = {
    "require_approval": True,
    "poll_seconds": 15,
    "channels": [{"id": c, "members": ["reviewer", c]} for c in ("358", "354", "361", "362")],
}


class World(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "agent-comms")
        os.makedirs(self.root)
        with open(os.path.join(self.root, "channels.json"), "w") as h:
            json.dump(CONFIG, h)
        self.folder = core.Folder(self.root, os.path.join(self.tmp.name, "state", "state.json"))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def seed(self, ch, sender, to, body, kind="ruling", hexid="aaaaaa", ts="2026-10-08T12:00:00.000Z"):
        m = {"v": 1, "id": f"{ts.replace(':', '-')}-{sender}-{hexid}", "from": sender, "to": to, "kind": kind, "ts": ts, "body": body}
        core.write_atomic(self.folder.channel_dir(ch, "messages"), m["id"] + ".json", core.format_message(m))
        return m

    def messages(self, ch):
        d = self.folder.channel_dir(ch, "messages")
        out = []
        for name in sorted(os.listdir(d)):
            with open(os.path.join(d, name)) as h:
                out.append(json.loads(h.read()))
        return out

    def thread(self, ch):
        return self.folder.snapshot()["threads"][ch]


class CoreTests(World):
    def test_format_is_the_mods_exact_text(self):
        m = {"v": 1, "id": "2026-10-03T12-00-00.123Z-358-a1b2c3", "from": "358", "to": "reviewer", "kind": "report", "ts": "2026-10-03T12:00:00.123Z", "body": 'line one\n"quoted" ✓'}
        self.assertEqual(
            core.format_message(m),
            '{"v":1,"id":"2026-10-03T12-00-00.123Z-358-a1b2c3","from":"358","to":"reviewer","kind":"report","ts":"2026-10-03T12:00:00.123Z","body":"line one\\n\\"quoted\\" ✓"}\n',
        )
        self.assertEqual(core.parse_message(core.format_message(m), m["id"]), m)

    def test_only_a_reviewer_message_to_an_agent_waits(self):
        to_agent = self.seed("358", "reviewer", "358", "for the agent", hexid="000001")
        self.seed("358", "reviewer", "maintainer", "for you", kind="note", hexid="000002")
        self.seed("358", "358", "reviewer", "agent reply", kind="answer", hexid="000003")
        snap = self.folder.snapshot()
        waiting = [m["id"] for m in snap["threads"]["358"] if m["pending"]]
        self.assertEqual(waiting, [to_agent["id"]])
        self.assertEqual(next(c for c in snap["channels"] if c["id"] == "358")["pending"], 1)

    def test_approve_writes_the_approval_and_it_stops_waiting(self):
        m = self.seed("358", "reviewer", "358", "Split the PR.")
        info = self.folder.approve("358", m["id"])
        self.assertEqual(info, "✓ Approved reviewer's ruling to 358; it reaches 358 at its next step.")
        with open(os.path.join(self.folder.channel_dir("358", "approvals"), m["id"] + ".json")) as h:
            record = json.loads(h.read())
        self.assertEqual((record["id"], record["by"]), (m["id"], "maintainer"))
        self.assertFalse(self.thread("358")[0]["pending"])
        self.assertTrue(self.folder.approve("358", m["id"]).startswith("Not approved"))

    def test_hold_tells_reviewer_and_agent_once_never_the_maintainer(self):
        m = self.seed("358", "reviewer", "358", "Split the PR into two.", kind="answer")
        self.folder.hold("358", m["id"])
        notes = [x for x in self.messages("358") if x["from"] == "maintainer"]
        self.assertEqual(sorted(n["to"] for n in notes), ["358", "reviewer"])
        to_agent = next(n for n in notes if n["to"] == "358")
        self.assertTrue(to_agent["body"].startswith("On hold: an answer from reviewer to you"))
        self.assertTrue(self.thread("358")[0]["held"])
        self.assertTrue(self.thread("358")[0]["pending"])
        self.assertTrue(self.folder.hold("358", m["id"]).startswith("Already on hold"))
        self.assertEqual(len([x for x in self.messages("358") if x["from"] == "maintainer"]), 2)
        self.assertFalse(any(x["from"] == "maintainer" and x["to"] == "maintainer" for x in self.messages("358")))

    def test_decline_records_the_reason_and_tells_only_the_reviewer(self):
        m = self.seed("354", "reviewer", "354", "Rewrite the parser.")
        self.folder.decline("354", m["id"], "Too big for this PR.")
        with open(os.path.join(self.folder.channel_dir("354", "declined"), m["id"] + ".json")) as h:
            self.assertEqual(json.loads(h.read())["reason"], "Too big for this PR.")
        notes = {n["to"]: n["body"] for n in self.messages("354") if n["from"] == "maintainer"}
        self.assertEqual(list(notes), ["reviewer"])  # the agent is never told
        self.assertIn("Reason: Too big for this PR.", notes["reviewer"])
        item = next(x for x in self.thread("354") if x["id"] == m["id"])
        self.assertEqual((item["pending"], item["declined"]), (False, "Too big for this PR."))
        self.assertTrue(self.folder.approve("354", m["id"]).startswith("Not approved"))

    def test_post_to_agent_and_reviewer_and_refuse_outsiders(self):
        self.assertEqual(self.folder.post("358", "358", "question", "Ready?"), "Sent a question to 358 on #358.")
        self.assertEqual(self.folder.post("358", "reviewer", "note", "Please look at 358."), "Sent a note to reviewer on #358.")
        self.assertTrue(self.folder.post("358", "362", "note", "x").startswith("Not sent"))
        self.assertTrue(self.folder.post("358", "maintainer", "note", "x").startswith("Not sent"))
        self.assertEqual([(m["from"], m["to"]) for m in self.messages("358")], [("maintainer", "358"), ("maintainer", "reviewer")] if self.messages("358")[0]["to"] == "358" else [("maintainer", "reviewer"), ("maintainer", "358")])

    def test_unread_and_seen(self):
        self.seed("358", "358", "maintainer", "hello", kind="question", hexid="000004")
        snap = self.folder.snapshot()
        self.assertEqual(next(c for c in snap["channels"] if c["id"] == "358")["unread"], 1)
        self.assertTrue(snap["threads"]["358"][0]["fresh"])
        self.folder.mark_seen("358")
        snap = self.folder.snapshot()
        self.assertEqual(next(c for c in snap["channels"] if c["id"] == "358")["unread"], 0)

    def test_unreadable_files_are_counted(self):
        d = self.folder.channel_dir("358", "messages")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "2026-10-08T12-00-00.000Z-maintainer-ffffff.json"), "w") as h:
            h.write('{"v":1,"id":"2026-10-08T12-00-00.000Z-maintainer-ffffff","from":"maintainer","to":"maintainer","kind":"note","ts":"2026-10-08T12:00:00.000Z","body":"x"}')
        with open(os.path.join(d, ".half.json.tmp"), "w") as h:
            h.write("{")
        self.assertEqual(next(c for c in self.folder.snapshot()["channels"] if c["id"] == "358")["skipped"], 1)


class ServerTests(World):
    def setUp(self) -> None:
        super().setUp()
        self.token = "test-token-123"
        self.httpd = server.serve(self.folder, 0, self.token)
        self.port = self.httpd.server_address[1]
        # serve() was given port 0: tell the handler the real one
        self.httpd.RequestHandlerClass = server.make_handler(self.folder, self.token, {"port": self.port})
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def request(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": host or f"127.0.0.1:{self.port}"}
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, data

    def post(self, path, payload, token=True, content_type="application/json"):
        headers = {"Content-Type": content_type}
        if token:
            headers["X-Comms-Token"] = self.token
        return self.request("POST", path, json.dumps(payload), headers)

    def test_page_needs_the_key(self):
        self.assertEqual(self.request("GET", "/")[0], 403)
        self.assertEqual(self.request("GET", "/?t=wrong")[0], 403)
        status, page = self.request("GET", f"/?t={self.token}")
        self.assertEqual(status, 200)
        self.assertIn(b"Agent Comms", page)

    def test_another_host_name_is_refused(self):
        # a web page reaching this port through its own domain (DNS rebinding) carries its own Host
        self.assertEqual(self.request("GET", f"/?t={self.token}", host="evil.example:80")[0], 403)
        self.assertEqual(self.request("GET", "/api/state", headers={"X-Comms-Token": self.token}, host="evil.example")[0], 403)

    def test_state_needs_the_key_header(self):
        self.assertEqual(self.request("GET", "/api/state")[0], 403)
        status, body = self.request("GET", "/api/state", headers={"X-Comms-Token": self.token})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(json.loads(body)["server_version"], server.SERVER_VERSION)

    def test_the_page_and_the_server_carry_the_same_version(self):
        with open(os.path.join(server.HERE, "index.html")) as h:
            self.assertIn(f"const PAGE_VERSION = '{server.SERVER_VERSION}'", h.read())

    def test_approve_over_http_needs_the_key_and_json(self):
        m = self.seed("358", "reviewer", "358", "go")
        approval = os.path.join(self.folder.channel_dir("358", "approvals"), m["id"] + ".json")
        self.assertEqual(self.post("/api/approve", {"channel": "358", "id": m["id"]}, token=False)[0], 403)
        # a plain form post (what another site could send without a preflight) is refused
        self.assertEqual(self.post("/api/approve", {"channel": "358", "id": m["id"]}, content_type="text/plain")[0], 415)
        self.assertFalse(os.path.exists(approval))
        status, body = self.post("/api/approve", {"channel": "358", "id": m["id"]})
        self.assertEqual(status, 200)
        self.assertIn("Approved", json.loads(body)["info"])
        self.assertTrue(os.path.exists(approval))

    def test_hold_decline_post_seen_over_http(self):
        a = self.seed("358", "reviewer", "358", "one", hexid="000010")
        b = self.seed("354", "reviewer", "354", "two", hexid="000011")
        self.assertIn("On hold", json.loads(self.post("/api/hold", {"channel": "358", "id": a["id"]})[1])["info"])
        self.assertIn("Declined", json.loads(self.post("/api/decline", {"channel": "354", "id": b["id"], "reason": "no"})[1])["info"])
        self.assertIn("Sent", json.loads(self.post("/api/post", {"channel": "361", "to": "361", "kind": "note", "text": "hi"})[1])["info"])
        self.assertEqual(self.post("/api/seen", {"channel": "358"})[0], 200)



class HomeNetworkTests(World):
    """--lan: the phone pairs with the code shown on the Mac; nothing outside the home network is served."""

    def setUp(self) -> None:
        super().setUp()
        self.token = "mac-key-456"
        self.httpd = server.serve(self.folder, 0, self.token)  # bound to 127.0.0.1 in the test; the checks are what matter
        self.port = self.httpd.server_address[1]
        self.pairing = server.Pairing()
        self.lan = {"hosts": ["192.168.1.20", "my-mac.local"], "pairing": self.pairing, "url": f"http://192.168.1.20:{self.port}/phone"}
        self.httpd.RequestHandlerClass = server.make_handler(self.folder, self.token, {"port": self.port}, self.lan)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def request(self, method, path, body=None, headers=None, host="192.168.1.20"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": f"{host}:{self.port}"}
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        data = r.read()
        result = (r.status, data, r.getheader("Set-Cookie"), r.getheader("Location"))
        conn.close()
        return result

    def pair(self, code):
        return self.request("POST", "/api/pair", json.dumps({"code": code}), {"Content-Type": "application/json"})

    def test_only_home_addresses_count(self):
        for ip in ("127.0.0.1", "192.168.1.44", "10.0.0.7", "172.20.3.4", "::1"):
            self.assertTrue(server.is_home_client(ip), ip)
        for ip in ("8.8.8.8", "203.0.113.5", "100.64.0.9", "169.254.1.1", "172.32.0.1", "not-an-ip"):
            self.assertFalse(server.is_home_client(ip), ip)

    def test_an_unpaired_phone_is_sent_to_pairing_and_cannot_read(self):
        status, _, _, location = self.request("GET", "/")
        self.assertEqual((status, location), (302, "/phone"))
        status, page, _, _ = self.request("GET", "/phone")
        self.assertEqual(status, 200)
        self.assertIn(b"6-character code", page)
        self.assertEqual(self.request("GET", "/api/state")[0], 403)

    def test_the_right_code_pairs_and_the_cookie_works(self):
        status, _, cookie, _ = self.pair(self.pairing.code.lower())  # case and spaces do not matter
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        session = cookie.split(";")[0]
        self.assertEqual(self.request("GET", "/", headers={"Cookie": session})[0], 200)
        status, body, _, _ = self.request("GET", "/api/state", headers={"Cookie": session})
        self.assertEqual(status, 200)
        state = json.loads(body)
        self.assertTrue(state["ok"])
        self.assertNotIn("phone", state)  # the code is never sent to a phone
        m = self.seed("358", "reviewer", "358", "go")
        status, body, _, _ = self.request("POST", "/api/approve", json.dumps({"channel": "358", "id": m["id"]}), {"Cookie": session, "Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertIn("Approved", json.loads(body)["info"])

    def test_five_wrong_codes_lock_pairing_even_for_the_right_one(self):
        for _ in range(4):
            self.assertIn(b"Wrong code", self.pair("ZZZZZZ" if self.pairing.code != "ZZZZZZ" else "YYYYYY")[1])
        self.assertIn(b"Too many wrong codes", self.pair("ZZZZZZ" if self.pairing.code != "ZZZZZZ" else "YYYYYY")[1])
        status, body, cookie, _ = self.pair(self.pairing.code)
        self.assertEqual((status, cookie), (403, None))
        self.assertIn(b"Too many wrong codes", body)

    def test_the_macs_page_gets_the_phone_link_and_code(self):
        status, body, _, _ = self.request("GET", "/api/state", headers={"X-Comms-Token": self.token}, host="127.0.0.1")
        self.assertEqual(status, 200)
        phone = json.loads(body)["phone"]
        self.assertEqual(phone["code"], self.pairing.code)
        self.assertTrue(phone["url"].endswith("/phone"))
        self.assertEqual(phone["qr"], qr.rows(qr.encode(f"{phone['url']}?c={self.pairing.code}")))

    def test_other_host_names_and_form_posts_are_refused(self):
        self.assertEqual(self.request("GET", "/phone", host="evil.example")[0], 403)
        self.assertEqual(self.request("POST", "/api/pair", json.dumps({"code": self.pairing.code}), {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.pairing.failures, 0)



class GroupTests(World):
    def test_create_group_adds_it_with_one_setup_note_to_everyone(self):
        info = self.folder.create_group("team-a", ["354", "358"])
        self.assertEqual(info, "Group #team-a is ready: reviewer, 354, 358.")
        with open(os.path.join(self.root, "channels.json")) as h:
            cfg = json.load(h)
        self.assertEqual(cfg["channels"][-1], {"id": "team-a", "members": ["reviewer", "354", "358"]})
        self.assertEqual(len(cfg["channels"]), 5)
        notes = self.messages("team-a")
        self.assertEqual(len(notes), 1)
        self.assertEqual((notes[0]["from"], notes[0]["to"]), ("maintainer", "all"))
        self.assertIn("is ready", self.folder.create_group("team-a", ["358", "354"]))  # same members: fine, nothing new
        self.assertEqual(len(self.messages("team-a")), 1)
        self.assertIn("already exists", self.folder.create_group("team-a", ["354", "361"]))
        self.assertIn("can't be a group name", self.folder.create_group("777", ["354", "358"]))
        self.assertIn("at least two agents", self.folder.create_group("solo", ["354"]))
        snap = self.folder.snapshot()
        self.assertTrue(next(c for c in snap["channels"] if c["id"] == "team-a")["group"])
        self.assertFalse(next(c for c in snap["channels"] if c["id"] == "358")["group"])
        self.assertEqual(snap["agents"], ["358", "354", "361", "362"])

    def test_messages_to_all_in_a_group(self):
        self.folder.create_group("team", ["354", "358"])
        self.assertEqual(self.folder.post("team", "all", "note", "Hello team"), "Sent a note to everyone in #team.")
        self.assertTrue(self.folder.post("358", "all", "note", "x").startswith("Not sent"))  # not a group
        waiting = self.seed("team", "reviewer", "all", "Freeze the API.", hexid="ab0001", ts="2026-10-08T13:00:00.000Z")
        agent = self.seed("team", "354", "all", "PR is up.", kind="report", hexid="ab0002", ts="2026-10-08T13:01:00.000Z")
        items = {m["id"]: m for m in self.thread("team")}
        self.assertTrue(items[waiting["id"]]["pending"])
        self.assertFalse(items[agent["id"]]["pending"])
        self.folder.hold("team", waiting["id"])
        notes = [m for m in self.messages("team") if m["from"] == "maintainer" and m["body"].startswith("On hold")]
        self.assertEqual([(n["to"]) for n in notes], ["all"])  # ONE note to the group
        self.assertIn("to the group", notes[0]["body"])
        self.folder.decline("team", waiting["id"], "Not yet.")
        declines = [m for m in self.messages("team") if m["from"] == "maintainer" and m["body"].startswith("Declined")]
        self.assertEqual([n["to"] for n in declines], ["reviewer"])  # no agent in the group is told

    def test_create_group_over_http(self):
        token = "k"
        httpd = server.serve(self.folder, 0, token)
        port = httpd.server_address[1]
        httpd.RequestHandlerClass = server.make_handler(self.folder, token, {"port": port})
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("POST", "/api/group", json.dumps({"name": "team", "agents": ["354", "358"]}),
                         {"Host": f"127.0.0.1:{port}", "X-Comms-Token": token, "Content-Type": "application/json"})
            r = conn.getresponse()
            body = json.loads(r.read())
            conn.close()
            self.assertEqual(r.status, 200)
            self.assertIn("is ready", body["info"])
        finally:
            httpd.shutdown()
            httpd.server_close()



class QrTests(unittest.TestCase):
    def test_sizes_and_limits(self):
        self.assertEqual(len(qr.encode("HELLO")), 21)  # version 1
        self.assertEqual(len(qr.encode("http://192.168.1.20:8765/phone?c=NETWF9")), 29)  # version 3
        self.assertEqual(len(qr.encode("x" * 106)), 41)  # version 6, the most it takes
        with self.assertRaises(ValueError):
            qr.encode("x" * 107)

    def test_terminal_rendering_keeps_every_module(self):
        import re
        m = qr.encode("http://192.168.1.20:8765/phone?c=NETWF9")
        back = []
        for line in qr.terminal(m, quiet=0).split("\n"):
            row, colour = [], None
            for code, cell in re.findall(r"\033\[(\d+)m|(  )", line):
                if code:
                    colour = code
                elif cell:
                    row.append(colour == "40")
            back.append(row)
        self.assertEqual(back, m)
        self.assertNotIn("▀", qr.terminal(m))  # no half blocks: they leave seams in Terminal


class PairingRotationTests(unittest.TestCase):
    def test_the_code_changes_after_a_pairing(self):
        seen = []
        p = server.Pairing(on_paired=seen.append)
        first = p.code
        self.assertEqual(p.attempt(first), "ok")
        self.assertNotEqual(p.code, first)
        self.assertEqual(seen, [p.code])
        self.assertEqual(p.attempt(first), "wrong")  # an old QR pairs nothing
        self.assertEqual(p.attempt(p.code), "ok")



class ReviewerModeAndDirectTests(World):
    def test_reviewer_mode_is_saved_in_channels_json_keeping_everything_else(self):
        self.assertEqual(self.folder.snapshot()["reviewer_mode"], "code")
        self.assertIn("Chat agent", self.folder.set_reviewer_mode("chat"))
        with open(os.path.join(self.root, "channels.json")) as h:
            cfg = json.load(h)
        self.assertEqual(cfg["reviewer_mode"], "chat")
        self.assertEqual(cfg["poll_seconds"], 15)
        self.assertEqual(len(cfg["channels"]), 4)
        self.assertEqual(self.folder.snapshot()["reviewer_mode"], "chat")
        self.assertIn("either", self.folder.set_reviewer_mode("robot"))

    def test_direct_is_added_once_and_needs_no_approval(self):
        self.assertFalse(self.folder.snapshot()["has_direct"])
        self.assertIn("#direct is ready", self.folder.ensure_direct())
        self.folder.ensure_direct()
        with open(os.path.join(self.root, "channels.json")) as h:
            cfg = json.load(h)
        self.assertEqual([c for c in cfg["channels"] if c["id"] == "direct"], [{"id": "direct", "members": ["reviewer", "maintainer"]}])
        snap = self.folder.snapshot()
        self.assertTrue(snap["has_direct"])
        self.assertEqual(self.folder.post("direct", "reviewer", "question", "Anything blocking?"), "Sent a question to reviewer on #direct.")
        r = self.seed("direct", "reviewer", "maintainer", "No.", kind="answer", hexid="d00001", ts="2026-10-08T14:00:00.000Z")
        item = next(m for m in self.thread("direct") if m["id"] == r["id"])
        self.assertFalse(item["pending"])
        self.assertTrue(self.folder.post("direct", "358", "note", "x").startswith("Not sent"))



class NoHardLinkTests(World):
    def test_a_drive_without_hard_links_still_writes_atomically_and_never_clobbers(self):
        real_link = os.link
        def no_links(*args, **kwargs):
            raise OSError(1, "Operation not permitted")
        os.link = no_links
        try:
            d = self.folder.channel_dir("358", "messages")
            core.write_atomic(d, "a.json", "one\n")
            with self.assertRaises(FileExistsError):
                core.write_atomic(d, "a.json", "two\n")
            with open(os.path.join(d, "a.json")) as h:
                self.assertEqual(h.read(), "one\n")
            self.assertEqual(sorted(os.listdir(d)), ["a.json"])
        finally:
            os.link = real_link


if __name__ == "__main__":
    unittest.main()
