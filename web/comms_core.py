"""The agent-comms folder rules, as the Claude Code mod (hooks/format.ts) applies them.

Standard library only; Python 3.9+. Every function here is pure or touches only
the comms folder through write_atomic, so the web server and its tests share it.
"""

import json
import os
import re
import secrets
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

KINDS = ("question", "report", "blocked", "ruling", "answer", "note")
REVIEWER = "reviewer"
ALL = "all"  # `to` for a group message: every member but its sender
DIRECT = "direct"  # the maintainer and the reviewer alone
MAINTAINER = "maintainer"
SETUP_MARKER = "[agent-comms setup]"
ID_RE = re.compile(r"\A[A-Za-z0-9_-]{1,32}\Z")
TS_RE = re.compile(r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\Z")
SEEN_CAP = 1000
# one maintainer action at a time on a message: a double click, or two desk pages, never sends notes twice
_ACTION_LOCK = threading.Lock()
# a hold record still missing recipients, claimed this recently, is being sent by another desk right now
HOLD_IN_PROGRESS_S = 30
# finishing someone's unfinished hold: claim it, wait this long, and go on only if the claim is still ours
HOLD_CLAIM_SETTLE_S = 0.2


def is_id(value: Any) -> bool:
    return isinstance(value, str) and bool(ID_RE.match(value))


def is_ts(value: Any) -> bool:
    """The plugin's check: the pattern, then the field ranges its runtime's Date.parse checks. Date.parse
    does not check the calendar (Feb 30 rolls over to Mar 2, year 0000 is fine) and takes 24:00:00 as the
    next midnight, so a stricter check here would hide messages the plugin shows and delivers."""
    if not isinstance(value, str) or not TS_RE.match(value):
        return False
    month, day = int(value[5:7]), int(value[8:10])
    hour, minute, second = int(value[11:13]), int(value[14:16]), int(value[17:19])
    if not (1 <= month <= 12 and 1 <= day <= 31 and minute <= 59 and second <= 59):
        return False
    return hour <= 23 or (hour == 24 and minute == 0 and second == 0 and not re.search(r"\.[0-9]*[1-9]", value))


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


def is_reserved_id(i: str) -> bool:
    """Names no agent or group may take, in any case (folders on macOS and Windows ignore case too)."""
    return i.lower() in (ALL, MAINTAINER, "off") or is_reviewer(i)


def is_group_id(i: str) -> bool:
    return is_id(i) and not i.isdigit() and not is_reserved_id(i)


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


def well_formed(text: str) -> str:
    """Any surrogate left in a Python str is a lone one (json.loads joins real pairs): made U+FFFD, as the plugin's wellFormed()."""
    return re.sub("[\ud800-\udfff]", "\ufffd", text)


def dumps(value: Any) -> str:
    """JSON as the mod's JSON.stringify writes it: compact, UTF-8 kept, never half an emoji."""
    return well_formed(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


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


def seen_test(value: Any):
    """Whether the maintainer saw an id: `value` is the ids marked when the channel was last opened
    (an id older than the oldest kept counts as seen), or a legacy single id (ids at or before it)."""
    if isinstance(value, str):
        return lambda i: i <= value
    ids = [i for i in value if isinstance(i, str)] if isinstance(value, list) else []
    if not ids:
        return lambda i: False
    kept, oldest = set(ids), ids[0]
    return lambda i: i in kept or (len(ids) >= SEEN_CAP and i < oldest)


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
            try:
                os.link(temp, final)  # FileExistsError if it is there: a message is never replaced
                os.unlink(temp)
            except FileExistsError:
                raise
            except OSError:
                # no hard links on this drive (FAT/exFAT): check, then rename. On Windows os.rename itself
                # refuses an existing name; elsewhere the check covers it (names carry 24 random bits)
                if os.path.exists(final):
                    raise FileExistsError(final)
                os.rename(temp, final)
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

    def _config_text(self) -> Optional[str]:
        """channels.json's text, read again (3 times, 150 ms apart) while it does not parse:
        the plugin writes it in place, so a read can land in the middle of a write."""
        text = None
        for attempt in range(3):
            try:
                with open(os.path.join(self.root, "channels.json"), encoding="utf-8") as handle:
                    text = handle.read()
            except OSError:
                return None
            try:
                json.loads(text)
                return text
            except ValueError:
                if attempt < 2:
                    time.sleep(0.15)
        return text

    def config(self) -> Optional[Dict[str, Any]]:
        text = self._config_text()
        return parse_config(text) if text is not None else None

    # ---- reading
    def _records(self, ch: str, sub: str, unreadable: Optional[Set[str]] = None) -> Dict[str, Dict[str, Any]]:
        """The records in channels/<ch>/<sub>/ that parse; the stems of those that do not go into `unreadable`."""
        out: Dict[str, Dict[str, Any]] = {}
        d = self.channel_dir(ch, sub)
        for name in os.listdir(d) if os.path.isdir(d) else []:
            if not is_candidate(name):
                continue
            try:
                with open(os.path.join(d, name), encoding="utf-8") as handle:
                    record = parse_record(handle.read(), name[:-5])
            except (OSError, UnicodeDecodeError):
                record = None
            if record is not None:
                out[name[:-5]] = record
            elif unreadable is not None:
                unreadable.add(name[:-5])
        return out

    def held_claimed_at(self, ch: str, mid: str) -> Optional[float]:
        """When a hold's record was claimed (its "ts"), in seconds since the epoch; None when it does not say."""
        try:
            with open(os.path.join(self.channel_dir(ch, "held"), mid + ".json"), encoding="utf-8") as handle:
                ts = json.loads(handle.read()).get("ts")
            return datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        except (OSError, ValueError, AttributeError, TypeError):
            return None

    def held_marks(self, ch: str, mid: str) -> Tuple[bool, Optional[str]]:
        """A hold record's "failed" flag (its last note could not be written) and its "claim" token."""
        try:
            with open(os.path.join(self.channel_dir(ch, "held"), mid + ".json"), encoding="utf-8") as handle:
                value = json.loads(handle.read())
        except (OSError, ValueError, UnicodeDecodeError):
            return False, None
        if not isinstance(value, dict):
            return False, None
        claim = value.get("claim")
        return value.get("failed") is True, claim if isinstance(claim, str) else None

    def held_records(self, ch: str) -> Dict[str, Optional[List[str]]]:
        """Messages on hold: channels/<ch>/held/<id>.json, written by this desk or the plugin's pane, each with
        who was told so far ("told"); None when the record does not say (an older one: everyone)."""
        d = self.channel_dir(ch, "held")
        out: Dict[str, Optional[List[str]]] = {}
        for name in os.listdir(d) if os.path.isdir(d) else []:
            if not is_candidate(name):
                continue
            told: Optional[List[str]] = None
            try:
                with open(os.path.join(d, name), encoding="utf-8") as handle:
                    value = json.loads(handle.read())
                if isinstance(value, dict) and isinstance(value.get("told"), list):
                    told = [t for t in value["told"] if isinstance(t, str)]
            except (OSError, ValueError, UnicodeDecodeError):
                told = None
            out[name[:-5]] = told
        return out

    def held_ids(self, ch: str) -> Set[str]:
        return set(self.held_records(ch))

    def _write_held(self, ch: str, mid: str, ts: str, told: List[str], replace: bool, failed: bool = False, claim: Optional[str] = None) -> None:
        record: Dict[str, Any] = {"id": mid, "by": MAINTAINER, "ts": ts, "told": told}
        if failed:
            record["failed"] = True
        if claim is not None:
            record["claim"] = claim
        write_atomic(self.channel_dir(ch, "held"), mid + ".json", dumps(record) + "\n", replace=replace)

    def migrate_legacy_held(self, cfg: Dict[str, Any]) -> None:
        """Holds kept only in this desk's state.json (before holds were files): written as files once, so the plugin sees them."""
        state = self.state()
        legacy = list(state.get("held", []))
        if not legacy:
            return
        for channel in cfg["channels"]:
            messages, _, _, approved, declined = self.scan(channel)
            records = self.held_records(channel["id"])
            for m in messages:
                if m["id"] in legacy and m["id"] not in records and is_awaiting_approval(m, approved, set(declined), cfg["require_approval"]):
                    try:
                        self._write_held(channel["id"], m["id"], iso_now(), [ALL] if m["to"] == ALL else [m["from"], m["to"]], replace=False)
                    except FileExistsError:
                        pass
        state["held"] = []
        self.save_state(state)

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
        try:
            self.migrate_legacy_held(cfg)
        except OSError as error:
            # the page still loads: the old list is still read below, and the move is tried again next poll
            print(f"agent-comms web: could not move the old holds into files: {error}", file=sys.stderr, flush=True)
        state = self.state()
        seen = state.get("seen", {})
        legacy_held = set(state.get("held", []))
        channels, threads = [], {}
        for channel in cfg["channels"]:
            messages, skipped, missing, approved, declined = self.scan(channel)
            is_seen = seen_test(seen.get(channel["id"]))
            records = self.held_records(channel["id"])

            def is_held(m, records=records):
                # on hold once everyone it concerns was told; an unfinished hold keeps its Hold button
                if m["id"] in legacy_held:
                    return True
                if m["id"] not in records:
                    return False
                told = records[m["id"]]
                return told is None or all(r in told for r in ([ALL] if m["to"] == ALL else [m["from"], m["to"]]))
            reviewers = reviewers_of(channel)
            for m in messages:
                for i in (m["from"], m["to"]):
                    if is_reviewer(i) and member_of(channel, i) and i not in reviewers:
                        reviewers.append(i)
            items, pending, unread = [], 0, 0
            for m in messages:
                waiting = is_awaiting_approval(m, approved, set(declined), cfg["require_approval"])
                fresh = m["from"] != MAINTAINER and not is_seen(m["id"])
                pending += waiting
                unread += fresh
                items.append({
                    **m,
                    "pending": waiting,
                    "held": waiting and is_held(m),
                    "declined": declined.get(m["id"]),
                    "approved": m["id"] in approved,
                    "needs_approval": needs_approval(m),
                    "fresh": fresh,
                    "setup": m["from"] == MAINTAINER and m["kind"] == "note" and m["body"].startswith(SETUP_MARKER),
                })
            channels.append({
                "id": channel["id"],
                "agents": agents_of(channel),
                "reviewers": reviewers,
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

    def _record_is_unreadable(self, ch: str, sub: str, mid: str) -> bool:
        """An approval or decline file for `mid` exists but does not parse (half written, or not the maintainer's)."""
        bad: Set[str] = set()
        self._records(ch, sub, bad)
        return mid in bad

    def approve(self, ch: str, mid: str) -> str:
        m, why = self._find_waiting(ch, mid)
        if m is None:
            return f"Not approved: {why}"
        # a file that does not parse is replaced by the maintainer's own record
        replace = self._record_is_unreadable(ch, "approvals", mid)
        try:
            write_atomic(self.channel_dir(ch, "approvals"), mid + ".json", dumps({"id": mid, "by": MAINTAINER, "ts": iso_now()}) + "\n", replace=replace)
        except FileExistsError:
            return "Already approved elsewhere a moment ago."
        return f"✓ Approved {m['from']}'s {m['kind']} to {m['to']}; it reaches {m['to']} at its next step."

    def hold(self, ch: str, mid: str) -> str:
        """The hold is a file the plugin's pane reads too: its first writer tells the others, the second tells no
        one twice. The file records who was told, so a note that failed is sent at the next Hold."""
        with _ACTION_LOCK:
            return self._hold(ch, mid)

    def _hold(self, ch: str, mid: str) -> str:
        m, why = self._find_waiting(ch, mid)
        if m is None:
            return f"Not held: {why}"
        agent_side = "the group" if m["to"] == ALL else m["to"]
        recipients = [ALL] if m["to"] == ALL else [m["from"], m["to"]]
        ts = iso_now()
        records = self.held_records(ch)
        if mid in records or mid in set(self.state().get("held", [])):
            told = records.get(mid) or (recipients if records.get(mid) is None else [])
            claimed = self.held_claimed_at(ch, mid)
            unfinished = records.get(mid) is not None and any(r not in told for r in recipients)
            failed, _ = self.held_marks(ch, mid)
            # claimed in the last 30 s and not marked failed: another desk is sending it now (a time in the future never blocks)
            if unfinished and not failed and claimed is not None and 0 <= time.time() - claimed < HOLD_IN_PROGRESS_S:
                return "That hold is being sent from another desk right now; press Hold again in a moment if it does not finish."
            if unfinished:
                # finishing it: claim it afresh, so a desk reading it now sees a hold in progress, and go on
                # only if the claim is still ours a moment later
                claim = secrets.token_hex(6)
                self._write_held(ch, mid, ts, told, replace=True, claim=claim)
                time.sleep(HOLD_CLAIM_SETTLE_S)
                if self.held_marks(ch, mid)[1] != claim:
                    return "That hold is being finished from another desk right now."
        else:
            try:
                self._write_held(ch, mid, ts, [], replace=False)
            except FileExistsError:
                return "Already on hold."
            told = []
        missing = [r for r in recipients if r not in told]
        if not missing:
            return f"Already on hold; {m['from']} and {agent_side} were told."
        for r in missing:
            # declined from another desk meanwhile: no promise of word is sent after it
            if mid in self._records(ch, "declined"):  # a decline that parses
                return "Not held further: it was declined meanwhile."
            if r == ALL:
                # the group is told something waits, never what it says (the text is not approved); "all" reaches the reviewer too
                body = f"On hold: {with_article(m['kind'])} from {m['from']} to the group is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon."
            elif r == m["from"]:
                body = f"On hold: your {m['kind']} to {m['to']} (\"{first_line(m['body'])}\") is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon."
            else:
                body = f"On hold: {with_article(m['kind'])} from {m['from']} to you is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon."
            try:
                self._note(ch, r, body)
            except OSError:
                # marked failed, so the next Hold (here or in the pane) finishes it at once; unless another
                # desk has moved the record on meanwhile, which then stands
                try:
                    now = self.held_records(ch).get(mid)
                    if now is not None and sorted(now) == sorted(told):
                        self._write_held(ch, mid, ts, told, replace=True, failed=True)
                except OSError:
                    pass
                raise
            told = told + [r]
            self._write_held(ch, mid, ts, told, replace=True)
        return f"⏸ On hold: {m['from']} and {agent_side} were told to expect a message soon."

    def decline(self, ch: str, mid: str, reason: str) -> str:
        with _ACTION_LOCK:
            return self._decline(ch, mid, reason)

    def _decline(self, ch: str, mid: str, reason: str) -> str:
        """The reviewer always gets the reason. The agent (or the group) is told nothing, unless the
        message was on hold: then it was promised word, and is told only that it was declined."""
        m, why = self._find_waiting(ch, mid)
        if m is None:
            return f"Not declined: {why}"
        reason = reason.strip()
        replace = self._record_is_unreadable(ch, "declined", mid)
        try:
            write_atomic(self.channel_dir(ch, "declined"), mid + ".json", dumps({"id": mid, "by": MAINTAINER, "ts": iso_now(), "reason": reason}) + "\n", replace=replace)
        except FileExistsError:
            return "Already declined elsewhere a moment ago."
        records = self.held_records(ch)
        agent_recipient = ALL if m["to"] == ALL else m["to"]
        if mid in records:
            # "nothing is coming" only to a side that was told of the hold
            was_held = records[mid] is None or agent_recipient in (records[mid] or [])
        else:
            was_held = mid in set(self.state().get("held", []))
        line = f"Reason: {reason or '(no reason given)'}"
        to_whom = f"the group #{ch}" if m["to"] == ALL else m["to"]
        agent_side = "the group" if m["to"] == ALL else m["to"]
        if was_held:
            self._note(ch, m["from"], f"Declined: your {m['kind']} to {to_whom} (\"{first_line(m['body'])}\") was not delivered. {agent_side} had been told it was on hold, and is now told only that it was declined and nothing is coming.\n{line}")
            self._note(ch, m["to"], f"Declined: the {m['kind']} from {m['from']} that was on hold was declined. Nothing is coming; carry on with your work.")
            return f"✗ Declined; {m['from']} was told why, and {agent_side} that nothing is coming."
        self._note(ch, m["from"], f"Declined: your {m['kind']} to {to_whom} (\"{first_line(m['body'])}\") was not delivered, and {agent_side} was not told.\n{line}")
        return f"✗ Declined; only {m['from']} was told why."

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
        bad = [a for a in agents if not is_id(a) or is_reserved_id(a)]
        if bad:
            return f"Not agent ids: {', '.join(bad)}."

        def add(raw, cfg):
            # channel folders on macOS and Windows ignore case: #Team and #team would share one
            existing = next((c for c in cfg["channels"] if c["id"].lower() == name.lower()), None)
            if existing is not None:
                if existing["id"] == name and sorted(agents_of(existing)) == sorted(agents):
                    return "done"
                return f"#{existing['id']} already exists with {', '.join(existing['members'])}; pick another name."
            raw["channels"] = list(raw.get("channels", [])) + [{"id": name, "members": [REVIEWER] + agents}]
            return None

        why = self._change_config(add)
        if why:
            return why
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
                'In this group, "to": "all" reaches every member but the sender; "to": "<id>" reaches that member only. The maintainer sees the whole thread; the reviewer, like every member, receives what is addressed to it or to "all".\n'
                "A message from any reviewer reaches the agents only after the maintainer approves it. Agents post with comms_post and read with comms_read."
            )
            m = new_message(MAINTAINER, ALL, "note", body)
            write_atomic(self.channel_dir(name, "messages"), m["id"] + ".json", format_message(m))
        return f"Group #{name} is ready: {', '.join(group['members'])}."

    def _change_config(self, change) -> Optional[str]:
        """One change to channels.json (no lock exists between this desk and the plugin): read, let
        `change(raw, cfg)` edit the dict (return None), say it is already there ("done") or refuse
        (a reason); read again just before writing and start over if the file moved; write; then
        the next pass reads it back and checks the change survived. None when the change is in."""
        for attempt in range(4):
            text = self._config_text()
            if text is None:
                return "channels.json is missing or unreadable: run /comms-setup in Claude Code first."
            try:
                raw = json.loads(text)
            except ValueError:
                raw = None
            cfg = parse_config(text)
            if cfg is None or not isinstance(raw, dict):
                return "channels.json is unreadable; it was left alone."
            why = change(raw, cfg)
            if why == "done":
                return None
            if why:
                return why
            if attempt == 3:
                break
            if self._config_text() != text:
                continue
            write_atomic(self.root, "channels.json", json.dumps(raw, indent=2, ensure_ascii=False) + "\n", replace=True)
        return "channels.json kept changing under this write; try again."

    def _update_config(self, change) -> Optional[str]:
        """Sets a value in channels.json with `change(raw)` (edits the dict, or returns why not); every other field is kept."""
        def apply(raw, cfg):
            before = json.dumps(raw, sort_keys=True)
            why = change(raw)
            if why:
                return why
            return "done" if json.dumps(raw, sort_keys=True) == before else None

        return self._change_config(apply)

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
        # every message now on the channel, by id (the newest SEEN_CAP): not one high-water id a misdated message could push past
        seen[ch] = [m["id"] for m in messages][-SEEN_CAP:]
        state["seen"] = seen
        self.save_state(state)
