"""The agent-comms folder rules, as the Claude Code mod (hooks/format.ts) applies them.

Standard library only; Python 3.9+. Every function here is pure or touches only
the comms folder through write_atomic, so the web server and its tests share it.
"""

import json
import os
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

KINDS = ("question", "report", "blocked", "ruling", "answer", "note")
REVIEWER = "reviewer"
ALL = "all"  # `to` for a group message: every member but its sender
DIRECT = "direct"  # the maintainer and the reviewer alone
MAINTAINER = "maintainer"
SETUP_MARKER = "[agent-comms setup]"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def is_id(value: Any) -> bool:
    return isinstance(value, str) and bool(ID_RE.match(value))


def is_ts(value: Any) -> bool:
    return isinstance(value, str) and bool(TS_RE.match(value))


def is_reviewer(i: str) -> bool:
    """`reviewer` (the cloud session) or any id starting with it (reviewer3)."""
    return i.lower().startswith(REVIEWER)


def member_of(channel: Dict[str, Any], i: str) -> bool:
    """Listed by name, or a reviewer in a channel with a reviewer slot."""
    return i in channel["members"] or (is_reviewer(i) and any(is_reviewer(m) for m in channel["members"]))


def agents_of(channel: Dict[str, Any]) -> List[str]:
    return [i for i in channel["members"] if not is_reviewer(i) and i != MAINTAINER]


def reviewers_of(channel: Dict[str, Any]) -> List[str]:
    return [i for i in channel["members"] if is_reviewer(i)]


def is_group(channel: Dict[str, Any]) -> bool:
    """A channel with more than one agent; its messages may go to everyone ("all")."""
    return len(agents_of(channel)) > 1


def is_group_id(i: str) -> bool:
    return is_id(i) and not i.isdigit() and i not in (ALL, MAINTAINER) and not is_reviewer(i)


def belongs_to(m: Dict[str, Any], channel: Dict[str, Any]) -> bool:
    def ok(i: str) -> bool:
        return i == MAINTAINER or member_of(channel, i)

    to_ok = ok(m["to"]) or (m["to"] == ALL and is_group(channel))
    return ok(m["from"]) and to_ok and m["from"] != m["to"]


def needs_approval(m: Dict[str, Any]) -> bool:
    """A reviewer message that reaches an agent (a group's "all" does)."""
    return is_reviewer(m["from"]) and (m["to"] == ALL or (not is_reviewer(m["to"]) and m["to"] != MAINTAINER))


def is_awaiting_approval(m: Dict[str, Any], approved: Set[str], declined: Set[str], require_approval: bool) -> bool:
    """Approval gates what a reviewer sends to an AGENT; one to the maintainer or a reviewer needs none."""
    return (
        needs_approval(m)
        and require_approval
        and m["id"] not in approved
        and m["id"] not in declined
    )


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_message(sender: str, to: str, kind: str, body: str) -> Dict[str, Any]:
    ts = iso_now()
    stem = f"{ts.replace(':', '-')}-{sender}-{secrets.token_hex(3)}"
    return {"v": 1, "id": stem, "from": sender, "to": to, "kind": kind, "ts": ts, "body": body}


def dumps(value: Any) -> str:
    """JSON as the mod's JSON.stringify writes it: compact, UTF-8 kept."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def format_message(m: Dict[str, Any]) -> str:
    return dumps({k: m[k] for k in ("v", "id", "from", "to", "kind", "ts", "body")}) + "\n"


def parse_message(text: str, stem: str) -> Optional[Dict[str, Any]]:
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("v") != 1 or isinstance(value.get("v"), bool):
        return None
    if value.get("id") != stem or not is_id(value.get("from")) or not is_id(value.get("to")):
        return None
    if value.get("kind") not in KINDS or not is_ts(value.get("ts")) or not isinstance(value.get("body"), str):
        return None
    return {k: value[k] for k in ("v", "id", "from", "to", "kind", "ts", "body")}


def parse_record(text: str, stem: str) -> Optional[Dict[str, Any]]:
    """An approval or a decline: {"id": stem, "by": "maintainer", "ts": ...[, "reason"]}."""
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("id") != stem or value.get("by") != MAINTAINER or not is_ts(value.get("ts")):
        return None
    return value


def is_candidate(name: str) -> bool:
    return not name.startswith(".") and name.endswith(".json")


def parse_config(text: str) -> Optional[Dict[str, Any]]:
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("channels"), list):
        return None
    channels = []
    for c in value["channels"]:
        if not isinstance(c, dict) or not is_id(c.get("id")) or not isinstance(c.get("members"), list):
            return None
        if not all(is_id(m) for m in c["members"]):
            return None
        channels.append({"id": c["id"], "members": list(c["members"])})
    return {
        "require_approval": value.get("require_approval") is not False,
        "reviewer_mode": "chat" if value.get("reviewer_mode") == "chat" else "code",
        "channels": channels,
    }


def with_article(word: str) -> str:
    return f"{'an' if word[:1].lower() in 'aeiou' else 'a'} {word}"


def first_line(body: str, limit: int = 80) -> str:
    line = next((l.strip() for l in body.split("\n") if l.strip()), "")
    return line if len(line) <= limit else line[: limit - 1] + "…"


def write_atomic(directory: str, name: str, text: str, replace: bool = False) -> str:
    """A dot-named temp file in the same folder, fsynced, then a hard link to the
    final name (fails if it exists: never clobbers) or os.replace (state files)."""
    os.makedirs(directory, exist_ok=True)
    final = os.path.join(directory, name)
    temp = os.path.join(directory, f".{name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if replace:
            os.replace(temp, final)
        else:
            os.link(temp, final)
            os.unlink(temp)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return final


class Folder:
    """One comms root; reads channels and threads, writes the maintainer's actions."""

    def __init__(self, root: str, state_path: str) -> None:
        self.root = root
        self.state_path = state_path

    # ---- paths and state
    def channel_dir(self, ch: str, sub: str) -> str:
        return os.path.join(self.root, "channels", ch, sub)

    def state(self) -> Dict[str, Any]:
        try:
            with open(self.state_path, encoding="utf-8") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def save_state(self, state: Dict[str, Any]) -> None:
        write_atomic(os.path.dirname(self.state_path), os.path.basename(self.state_path), dumps(state) + "\n", replace=True)

    def config(self) -> Optional[Dict[str, Any]]:
        try:
            with open(os.path.join(self.root, "channels.json"), encoding="utf-8") as handle:
                return parse_config(handle.read())
        except OSError:
            return None

    # ---- reading
    def _records(self, ch: str, sub: str) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        d = self.channel_dir(ch, sub)
        for name in os.listdir(d) if os.path.isdir(d) else []:
            if not is_candidate(name):
                continue
            try:
                with open(os.path.join(d, name), encoding="utf-8") as handle:
                    record = parse_record(handle.read(), name[:-5])
            except (OSError, UnicodeDecodeError):
                continue
            if record is not None:
                out[name[:-5]] = record
        return out

    def scan(self, channel: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], int, bool, Set[str], Dict[str, str]]:
        d = self.channel_dir(channel["id"], "messages")
        messages, skipped = [], 0
        missing = not os.path.isdir(d)
        for name in sorted(os.listdir(d)) if not missing else []:
            if not is_candidate(name):
                continue
            try:
                with open(os.path.join(d, name), encoding="utf-8") as handle:
                    m = parse_message(handle.read(), name[:-5])
            except (OSError, UnicodeDecodeError):
                m = None
            if m is None or not belongs_to(m, channel):
                skipped += 1
                continue
            messages.append(m)
        messages.sort(key=lambda m: (m["ts"], m["id"]))
        approved = set(self._records(channel["id"], "approvals"))
        declined = {k: str(v.get("reason", "")) for k, v in self._records(channel["id"], "declined").items()}
        return messages, skipped, missing, approved, declined

    def snapshot(self) -> Dict[str, Any]:
        cfg = self.config()
        if cfg is None:
            return {"ok": False, "error": "channels.json is missing or unreadable: run /comms-setup in Claude Code first."}
        state = self.state()
        seen = state.get("seen", {})
        held = set(state.get("held", []))
        channels, threads = [], {}
        for channel in cfg["channels"]:
            messages, skipped, missing, approved, declined = self.scan(channel)
            last_seen = seen.get(channel["id"], "")
            items, pending, unread = [], 0, 0
            for m in messages:
                waiting = is_awaiting_approval(m, approved, set(declined), cfg["require_approval"])
                fresh = m["from"] != MAINTAINER and m["id"] > last_seen
                pending += waiting
                unread += fresh
                items.append({
                    **m,
                    "pending": waiting,
                    "held": waiting and m["id"] in held,
                    "declined": declined.get(m["id"]),
                    "approved": m["id"] in approved,
                    "needs_approval": needs_approval(m),
                    "fresh": fresh,
                    "setup": m["from"] == MAINTAINER and m["kind"] == "note" and m["body"].startswith(SETUP_MARKER),
                })
            channels.append({
                "id": channel["id"],
                "agents": agents_of(channel),
                "reviewers": reviewers_of(channel),
                "group": is_group(channel),
                "pending": pending,
                "unread": unread,
                "skipped": skipped,
                "missing": missing,
            })
            threads[channel["id"]] = items
        return {
            "ok": True,
            "root": self.root,
            "channels": channels,
            "threads": threads,
            "agents": self.known_agents(),
            "reviewer_mode": cfg["reviewer_mode"],
            "has_direct": any(c["id"] == DIRECT for c in cfg["channels"]),
        }

    # ---- the maintainer's actions
    def _find_waiting(self, ch: str, mid: str) -> Tuple[Optional[Dict[str, Any]], str]:
        cfg = self.config()
        channel = next((c for c in (cfg or {}).get("channels", []) if c["id"] == ch), None)
        if cfg is None or channel is None:
            return None, f"#{ch} is not in channels.json."
        messages, _, _, approved, declined = self.scan(channel)
        m = next((x for x in messages if x["id"] == mid), None)
        if m is None or not is_awaiting_approval(m, approved, set(declined), cfg["require_approval"]):
            return None, "that message is no longer waiting for approval."
        return m, ""

    def _note(self, ch: str, to: str, body: str) -> None:
        if to == MAINTAINER:
            return  # never a note from the maintainer to the maintainer
        m = new_message(MAINTAINER, to, "note", body)
        write_atomic(self.channel_dir(ch, "messages"), m["id"] + ".json", format_message(m))

    def approve(self, ch: str, mid: str) -> str:
        m, why = self._find_waiting(ch, mid)
        if m is None:
            return f"Not approved: {why}"
        write_atomic(self.channel_dir(ch, "approvals"), mid + ".json", dumps({"id": mid, "by": MAINTAINER, "ts": iso_now()}) + "\n")
        return f"✓ Approved {m['from']}'s {m['kind']} to {m['to']}; it reaches {m['to']} at its next step."

    def hold(self, ch: str, mid: str) -> str:
        m, why = self._find_waiting(ch, mid)
        if m is None:
            return f"Not held: {why}"
        state = self.state()
        held = list(state.get("held", []))
        if mid in held:
            return f"Already on hold; {m['from']} and {m['to']} were told."
        if m["to"] == ALL:
            self._note(ch, ALL, f"On hold: {with_article(m['kind'])} from {m['from']} to the group (\"{first_line(m['body'])}\") is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon.")
        else:
            self._note(ch, m["from"], f"On hold: your {m['kind']} to {m['to']} (\"{first_line(m['body'])}\") is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon.")
            self._note(ch, m["to"], f"On hold: {with_article(m['kind'])} from {m['from']} to you is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon.")
        state["held"] = (held + [mid])[-500:]
        self.save_state(state)
        return f"⏸ On hold: {m['from']} and {m['to']} were told to expect a message soon."

    def decline(self, ch: str, mid: str, reason: str) -> str:
        m, why = self._find_waiting(ch, mid)
        if m is None:
            return f"Not declined: {why}"
        reason = reason.strip()
        write_atomic(self.channel_dir(ch, "declined"), mid + ".json", dumps({"id": mid, "by": MAINTAINER, "ts": iso_now(), "reason": reason}) + "\n")
        line = f"Reason: {reason or '(no reason given)'}"
        if m["to"] == ALL:
            self._note(ch, ALL, f"Declined: the maintainer declined {with_article(m['kind'])} from {m['from']} to the group (\"{first_line(m['body'])}\"); it will not be delivered.\n{line}")
        else:
            self._note(ch, m["from"], f"Declined: your {m['kind']} to {m['to']} (\"{first_line(m['body'])}\") was not delivered.\n{line}")
            self._note(ch, m["to"], f"Declined: the maintainer declined {with_article(m['kind'])} from {m['from']} to you; it will not be delivered.\n{line}")
        return f"✗ Declined; {m['from']} and {m['to']} were told why."

    def post(self, ch: str, to: str, kind: str, text: str) -> str:
        cfg = self.config()
        channel = next((c for c in (cfg or {}).get("channels", []) if c["id"] == ch), None)
        if channel is None:
            return f"Not sent: #{ch} is not in channels.json."
        to_ok = (to == ALL and is_group(channel)) or (is_id(to) and to != MAINTAINER and member_of(channel, to))
        if not to_ok:
            return f"Not sent: {to} is not in #{ch}."
        if kind not in KINDS:
            return "Not sent: unknown kind."
        if not text.strip():
            return "Not sent: the message is empty."
        m = new_message(MAINTAINER, to, kind, text.strip())
        write_atomic(self.channel_dir(ch, "messages"), m["id"] + ".json", format_message(m))
        self.mark_seen(ch)
        return f"Sent {with_article(kind)} to {'everyone in' if to == ALL else to + ' on'} #{ch}."

    def create_group(self, name: str, agents: List[str]) -> str:
        """Adds {id: name, members: [reviewer, *agents]} to channels.json (everything else kept),
        creates its folders and writes its setup note to everyone, as /comms-group does."""
        agents = list(dict.fromkeys(a.strip() for a in agents if a.strip()))
        if not is_group_id(name):
            return f'"{name}" can\'t be a group name: use letters, digits, - or _, not all digits.'
        if len(agents) < 2:
            return "A group needs at least two agents."
        bad = [a for a in agents if not is_id(a) or a in (ALL, MAINTAINER) or is_reviewer(a)]
        if bad:
            return f"Not agent ids: {', '.join(bad)}."
        path = os.path.join(self.root, "channels.json")
        for _ in range(3):
            try:
                with open(path, encoding="utf-8") as handle:
                    text = handle.read()
            except OSError:
                return "The folder is not set up yet: run /comms-setup in Claude Code first."
            cfg = parse_config(text)
            raw = json.loads(text) if cfg is not None else None
            if cfg is None or not isinstance(raw, dict):
                return "channels.json is unreadable; it was left alone."
            existing = next((c for c in cfg["channels"] if c["id"] == name), None)
            if existing is not None:
                if sorted(agents_of(existing)) == sorted(agents):
                    break
                return f"#{name} already exists with {', '.join(existing['members'])}; pick another name."
            merged = dict(raw)
            merged["channels"] = list(raw.get("channels", [])) + [{"id": name, "members": [REVIEWER] + agents}]
            write_atomic(self.root, "channels.json", json.dumps(merged, indent=2, ensure_ascii=False) + "\n", replace=True)
        cfg = self.config()
        group = next((c for c in (cfg or {}).get("channels", []) if c["id"] == name), None)
        if group is None:
            return "channels.json kept changing; the group was not added. Try again."
        os.makedirs(self.channel_dir(name, "messages"), exist_ok=True)
        os.makedirs(self.channel_dir(name, "approvals"), exist_ok=True)
        messages = self.scan(group)[0]
        if not any(m["from"] == MAINTAINER and m["body"].startswith(SETUP_MARKER) for m in messages):
            body = (
                f"{SETUP_MARKER} Group #{name}: members {', '.join(group['members'])}.\n"
                'In this group, "to": "all" reaches every member but the sender; "to": "<id>" reaches one member. Everyone in the group sees the whole thread.\n'
                "A message from any reviewer reaches the agents only after the maintainer approves it. Agents post with comms_post and read with comms_read."
            )
            m = new_message(MAINTAINER, ALL, "note", body)
            write_atomic(self.channel_dir(name, "messages"), m["id"] + ".json", format_message(m))
        return f"Group #{name} is ready: {', '.join(group['members'])}."

    def _update_config(self, change) -> Optional[str]:
        """Re-reads channels.json, applies `change(raw)` (which edits the dict, or returns why not)
        and writes it back atomically; every other field is kept. None when written."""
        path = os.path.join(self.root, "channels.json")
        try:
            with open(path, encoding="utf-8") as handle:
                raw = json.loads(handle.read())
        except (OSError, ValueError):
            return "channels.json is missing or unreadable: run /comms-setup in Claude Code first."
        if not isinstance(raw, dict) or parse_config(json.dumps(raw)) is None:
            return "channels.json is unreadable; it was left alone."
        why = change(raw)
        if why:
            return why
        write_atomic(self.root, "channels.json", json.dumps(raw, indent=2, ensure_ascii=False) + "\n", replace=True)
        return None

    def set_reviewer_mode(self, mode: str) -> str:
        if mode not in ("code", "chat"):
            return "The reviewer is either a Code session or a Chat agent."
        why = self._update_config(lambda raw: raw.__setitem__("reviewer_mode", mode))
        if why:
            return why
        return ("Reviewer: a Claude Code session. Messages to the reviewer wake the session that runs /comms-as reviewer."
                if mode == "code" else "Reviewer: a Chat agent. It reads the folder on its own schedule; nothing wakes it.")

    def ensure_direct(self) -> str:
        """Adds #direct (the maintainer and the reviewer alone) when channels.json has no such channel."""
        def add(raw):
            channels = raw.get("channels", [])
            if any(isinstance(c, dict) and c.get("id") == DIRECT for c in channels):
                return None
            raw["channels"] = list(channels) + [{"id": DIRECT, "members": [REVIEWER, MAINTAINER]}]
            return None

        why = self._update_config(add)
        if why:
            return why
        os.makedirs(self.channel_dir(DIRECT, "messages"), exist_ok=True)
        os.makedirs(self.channel_dir(DIRECT, "approvals"), exist_ok=True)
        return "#direct is ready: just you and the reviewer. Nothing in it needs approval."

    def known_agents(self) -> List[str]:
        cfg = self.config() or {"channels": []}
        seen: List[str] = []
        for c in cfg["channels"]:
            for a in agents_of(c):
                if a not in seen:
                    seen.append(a)
        return seen

    def mark_seen(self, ch: str) -> None:
        cfg = self.config()
        channel = next((c for c in (cfg or {}).get("channels", []) if c["id"] == ch), None)
        if channel is None:
            return
        messages = self.scan(channel)[0]
        if not messages:
            return
        state = self.state()
        seen = dict(state.get("seen", {}))
        seen[ch] = messages[-1]["id"]
        state["seen"] = seen
        self.save_state(state)
