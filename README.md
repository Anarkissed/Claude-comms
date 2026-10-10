# Claude-comms

**Approval-gated message channels between Claude Code agents, a reviewer, and you.**

Run several Claude Code agents on one project, have a reviewer (another Claude session) review their work, and stay in the loop: every message the reviewer sends to an agent waits for your **Approve** before the agent sees it. Agents and the reviewer write to each other through a plain folder of JSON files on your machine. There's no server in the cloud, no account and no network service, and you read and approve from a chat-style page on your Mac or your phone.

> Independent community project. It is **not** made by, endorsed by or affiliated with Anthropic. It uses Claude Code's early-access plugin ("function hooks") API, which can change between Claude Code releases. Tested with Claude Code 2.1.293.

## What you get

- **A channel per agent** with the reviewer, plus **group chats** (several agents and the reviewer, with "to everyone"), plus **#direct**: just you and the reviewer.
- **Your approval gate:** a reviewer message reaches an agent only after you approve it. You can also **Hold** it (both sides are told to expect word from you) or **Decline** it with a reason (it's never delivered).
- **Agents act on messages by themselves:** when a message reaches an idle agent session, the mod starts a turn there, so the agent reads it and gets to work. A busy agent gets it at its next step and is never interrupted.
- **The reviewer, your choice:** a **Claude Code session** (woken by every message sent to it) or a **Chat agent** that reads the folder on its own schedule.
- **Model tools** `comms_read` and `comms_post`, and a write guard: agents can't create, change or delete files in the comms folder except through `comms_post`, so they can't approve their own messages. (It's a process guard against mistakes, not a security boundary.)
- **A desk for you:**
  - in Claude Code, a `/comms` pane;
  - in your browser, an iMessage-style page with a conversation list, bubbles, approve/hold/decline, `Ctrl+1…9` shortcuts and a New group button;
  - **on your phone over your home Wi-Fi**, by scanning a QR code.

```
 agent sessions (Claude Code)            you                      reviewer
  ┌──────────┐ ┌──────────┐      ┌────────────────────┐      (Code session or
  │ frontend │ │ backend  │      │ /comms pane, web,  │       Chat agent)
  └────┬─────┘ └────┬─────┘      │ phone: Approve     │            │
       │ comms_post │            └─────────┬──────────┘            │
       ▼            ▼                      ▼                       ▼
  ~/agent-comms/channels/<channel>/{messages,approvals,declined}/*.json
```

## Install

You need Claude Code (terminal, desktop app or IDE) and, for the web desk, Python 3.9+ (on macOS, `/usr/bin/python3` is enough). Nothing else.

1. Clone the repository somewhere outside your projects:
   ```bash
   git clone https://github.com/Anarkissed/Claude-comms.git ~/claude-comms
   ```
2. Load the plugin in every Claude Code session. Add it to the `env` block of `~/.claude/settings.json` (your personal settings, not a project's):
   ```json
   "env": {
     "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/claude-comms/plugin",
     "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
   }
   ```
   `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` makes desktop-app sessions pick up plugin updates without a restart. Restart your sessions once.
3. In any session, run `/comms-setup`. It shows the folder (`~/agent-comms`; set `AGENT_COMMS_ROOT` to use another, outside any git repository), asks, then creates it with `channels.json` and #direct.

## Use

| Who | In which session | Command |
|---|---|---|
| Each agent | its own Claude Code session | `/comms-as frontend` (any name: letters, digits, `-`, `_`). The first time, this creates the agent's channel with the reviewer. |
| The reviewer (Code) | its own Claude Code session | `/comms-as reviewer`. To move it to a new chat later: `/comms-as reviewer` there, `/comms-as off` in the old one. |
| You | one extra Claude Code session | `/comms-as maintainer`, then `/comms` for the pane |

- **Groups:** `/comms-group team-a frontend backend`, or the ✎ button on the web page. The reviewer is always in it.
- **Reviewer mode:** the switch on the web page, or `"reviewer_mode": "code" | "chat"` in `channels.json`.
- **Phone approvals:** `/comms-approve <code>`, using the 6-character code shown with each waiting message.
- **Stop one session:** `/comms-as off`. Nothing more reaches its model, and the chat stays open.

### The web and phone desk

Double-click `web/Agent Comms.command` (this Mac only) or `web/Agent Comms (phone).command` (this Mac and your phone on the same Wi-Fi). Or run it from a terminal:

```bash
/usr/bin/python3 ~/claude-comms/web/server.py --open          # this Mac only
/usr/bin/python3 ~/claude-comms/web/server.py --lan --open    # plus your phone
```

- **Mac only:** it listens on `127.0.0.1`, and the page needs a fresh secret key from the link printed in the Terminal.
- **With your phone:** a QR code appears in the Terminal and on the Mac's page. Scan it and the phone pairs and opens the desk. Only home-network addresses are served, five wrong codes lock pairing, and the code changes after every pairing.
- **Plain HTTP:** traffic between your phone and the Mac isn't encrypted on the Wi-Fi itself, so use it on a home network you trust.

## The file format

For a reviewer that writes files itself, such as a Chat agent with file access:

```
~/agent-comms/
  channels.json
  channels/<channel>/messages/<UTC ISO time with ":" as "-">-<from>-<6 hex>.json
  channels/<channel>/approvals/<message id>.json     {"id", "by": "maintainer", "ts"}
  channels/<channel>/declined/<message id>.json      {"id", "by": "maintainer", "ts", "reason"}
```

```json
{"v": 1, "id": "2026-10-03T12-00-00.123Z-reviewer-a1b2c3", "from": "reviewer", "to": "frontend",
 "kind": "ruling", "ts": "2026-10-03T12:00:00.123Z", "body": "text (markdown welcome)"}
```

- **`id`** is the file name without `.json`.
- **`kind`** is one of `question`, `report`, `blocked`, `ruling`, `answer`, `note`.
- **`to`** names one member; in a group, `"all"` reaches every member but the sender.
- **Reviewers** are `reviewer` or any id starting with it. The `reviewer` member of a channel stands for every reviewer.
- **Writing a message:** write a temp file whose name starts with `.` in the same folder, then rename it into place. Never edit or delete a message, an approval or a decline.
- **Approval:** a reviewer message to an agent (or to `"all"`) reaches agents only once its approval file exists.

`channels.json`:

```json
{
  "require_approval": true, "poll_seconds": 15, "auto_wake": true, "reviewer_mode": "code",
  "channels": [
    {"id": "direct",   "members": ["reviewer", "maintainer"]},
    {"id": "frontend", "members": ["reviewer", "frontend"]},
    {"id": "team-a",   "members": ["reviewer", "frontend", "backend"]}
  ]
}
```

## Development

- **Plugin:** `claude plugin validate plugin` and `claude plugin test plugin` (66 tests). For type checking, run `/plugin-types plugin/.claude/types` in Claude Code, then `tsc -p plugin/tsconfig.json`.
- **Web:** `cd web && python3 -m unittest -v test_web` (28 tests). The QR encoder in `web/qr.py` is self-contained (byte mode, level M, versions 1–6).

Forks and pull requests are welcome. Released under the [MIT License](LICENSE).
