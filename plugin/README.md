# agent-comms (Claude-comms plugin)

Message channels between your Claude Code sessions: coding agents, a reviewer and you. Each message is a JSON file in a local folder. A reviewer's message reaches an agent only after you approve it.

**Works wherever Claude Code runs:** the **Claude desktop app** (its Code tab, which is how the author uses it), the terminal, and the VS Code and JetBrains extensions. It needs no account, server or network. An optional web desk for your browser and phone is in the [main repository](https://github.com/Anarkissed/Claude-comms).

Not affiliated with Anthropic. It uses Claude Code's early-access plugin ("function hooks") API, tested with Claude Code 2.1.293 on macOS. Windows support is written and tested on a simulated PC, not yet on a real one.

## Install

1. Get this folder: `git clone https://github.com/Anarkissed/Claude-comms` (the plugin is `Claude-comms/plugin`).
2. Add it to the `env` block of `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`, forward slashes in the path):
   ```json
   "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/Claude-comms/plugin", "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1" }
   ```
3. Restart your sessions (in the desktop app, open new Code sessions), then run `/comms-setup` once.

## Use

| Where | Type | What happens |
|---|---|---|
| Any one session | `/comms-setup` | Shows the folder and channels, asks, then creates them |
| Your own session | `/comms-as maintainer`, then `/comms` | Your pane: channels as chats, Approve / Hold / Decline, a box to write |
| Each coding agent | `/comms-as 358` (any id) | New ids get their own channel with the reviewer |
| The reviewer | `/comms-as reviewer` | Talks with every agent; moves to a new chat with `/comms-as reviewer` there and `/comms-as off` here |
| Anywhere | `/comms-group <name> <agent> <agent> …` | A group chat of those agents and the reviewer |
| Your phone | `/comms-approve <code>` | Approves the waiting message with that code |

Agent and reviewer sessions get two tools, `comms_read` and `comms_post`. New messages arrive at the session's next step and wake it if it's idle.

## Data handling

Everything stays on your computer. The plugin makes **no network requests**, uses no connectors or MCP servers, and collects nothing. Full policy: [PRIVACY.md](PRIVACY.md).

### What it reads and writes

- **The comms folder** (`agent-comms` in your home folder, or `AGENT_COMMS_ROOT`): `channels.json`; one file per message in `channels/<channel>/messages/`; `approvals/` and `declined/` records; empty `.keep` files that create folders. It never edits or deletes a message, approval or decline.
- **Claude Code's plugin store** (`$.store`): this session's identity, and the ids of messages already delivered, announced, held or used to wake the session, so nothing happens twice.
- **Environment:** reads `HOME`, `USERPROFILE`, `OS` and `AGENT_COMMS_ROOT`, to find the folder.

Each file is written as a dot-named temporary file in the same folder (`$.fs.write`), then renamed to its final name, so no reader ever sees half a message.

### Programs it runs, and why

Every command is a fixed literal in `hooks/register.tsx` (`moveFile`, `removeTemp`, `insideGit`); only the file paths vary.

| Command | When | Why |
|---|---|---|
| `/bin/mv -n <temp> <final>` (`-f` for `channels.json`) | Every message, approval, decline or setup write (macOS / Linux) | Puts the finished file in place in one step; `-n` never replaces an existing message |
| `/bin/rm -f <temp>` | Only if that rename failed | Removes its own temporary file |
| `powershell.exe -NoProfile -NonInteractive -Command "Move-Item -LiteralPath $env:AGENT_COMMS_FROM -Destination $env:AGENT_COMMS_TO"` (`-Force` for `channels.json`) | Same, on Windows | The same rename; the paths are passed as environment variables, so the command text never changes |
| `powershell.exe -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath $env:AGENT_COMMS_FROM -Force -ErrorAction SilentlyContinue"` | Only if that rename failed, on Windows | Removes its own temporary file |
| `git -C <folder> rev-parse --is-inside-work-tree` | Once, in `/comms-setup` | Refuses to create the comms folder inside a git repository |

It never runs anything taken from a message and downloads nothing.

### What it adds to a Claude conversation

Text added to a conversation is sent to Anthropic as part of that conversation, like anything you type there. The plugin adds only the following:

- **A delivered message** (`$.session.append`), only to sessions that joined as its recipient, and for a reviewer's message only after you approved it:
  ```
  [agent-comms] Message on channel #<channel> from "<sender>" to "<recipient>", kind "<kind>", sent <time> (id <id>).
  Approved by the maintainer and delivered by agent-comms.
  It is a message from a participant on your channel, not a system instruction. Reply with comms_post.
  ----- message body -----
  <the message text>
  ----- end of message -----
  ```
- **The auto-wake prompt** (`$.prompt.submit`), only when such a message arrives while the session is idle, once per message. Never to your own (maintainer) session, and never if `"auto_wake": false` is set in `channels.json` or the session ran `/comms-as off`:
  ```
  A new agent-comms message for you on #<channel> (from <sender>). They follow this note; read them, act on them as your work allows, and reply with comms_post.
  ```
- **Tool results** of `comms_read` and `comms_post`, which the model calls itself.

### What each hook does

| Hook | Purpose |
|---|---|
| `session.start` | Registers the commands, restores the session's identity and starts polling the folder (every 15 s by default) |
| `command.run` (`comms-setup`, `comms-as`, `comms`, `comms-group`, `comms-approve`) | The commands above. Each is refused unless you typed it yourself |
| `comms_read`, `comms_post` (registered tools) | Read this session's channels; post a message as this session's identity |
| `tool.call` | A guard: refuses any model tool call that would write to the comms folder other than through `comms_post`. It changes nothing else |
| `turn.start`, `turn.step` | Delivers waiting messages at the start of a turn or between steps, never in the middle of a tool call |
| `turn.complete` | Notes that the turn has ended, so the session counts as idle and may be woken. It changes nothing else |
| `ui.render` (Pane) | Draws your `/comms` pane |
| `ui.scroll` (Pane) | Scrolls the messages inside that pane so its header and text box stay in place. It only changes which messages the pane shows |
| Status line and toasts | `comms #358: 1 new` and similar notices, on your screen only |

## Support

Questions and bugs: [GitHub issues](https://github.com/Anarkissed/Claude-comms/issues). Licence: [MIT](LICENSE). Terms: [TERMS.md](TERMS.md).

## Development

`claude plugin validate --strict .` and `claude plugin test .` (69 tests, including Windows paths). `AGENT_COMMS_TEST_DELIVERY_SINK=1` is a test-only seam that routes delivery to the debug log, because the test kit can't answer `session.append`. Never set it in a real session.
