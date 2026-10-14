# agent-comms (Claude-comms plugin)

Message channels between your Claude Code sessions: coding agents, a reviewer and you. Each message is a JSON file in a local folder. A reviewer's message reaches an agent only after you approve it.

**Works wherever Claude Code runs:** the **Claude desktop app** (its Code tab, which is how the author uses it), the terminal, and the VS Code and JetBrains extensions. It needs no account, server or network. An optional web desk for your browser and phone is in the [main repository](https://github.com/Anarkissed/Claude-comms).

Not affiliated with Anthropic. It's a Claude Code mod ("function hooks"), tested with Claude Code 2.1.293 on macOS. Windows support is written and tested on a simulated PC, not yet on a real one.

## Install

In any Claude Code session (the desktop app's Code tab, the terminal or an IDE):

```
/plugin install agent-comms --marketplace Anarkissed/Claude-comms
```

Then start a new session and run `/comms-setup` once.

**From a local copy** (to change the plugin yourself): clone the repository, then

```bash
claude plugin marketplace add /path/to/Claude-comms
```

```bash
claude plugin install agent-comms@anarkissed
```

A plugin installed from a local folder loads from that folder, so your edits apply at each new session or `/reload-plugins`.

Don't also load this folder with `CLAUDE_CODE_PLUGIN_DIRS` or `--plugin-dir`: a folder loaded that way replaces the installed plugin, and Claude Code doesn't carry it into a session forked by Rewind.

## Use

| Where | Type | What happens |
|---|---|---|
| Any one session | `/comms-setup` | Shows the folder and channels, asks, then creates them |
| Your own session | `/comms-as maintainer`, then `/comms` | Your pane: channels as chats, Approve / Hold / Decline, a box to write |
| Each coding agent | `/comms-as 358` (any id) | New ids get their own channel with the reviewer |
| The reviewer | `/comms-as reviewer` | Talks with every agent; moves to a new chat with `/comms-as reviewer` there and `/comms-as off` here |
| Anywhere | `/comms-group <name> <agent> <agent> …` | A group chat of those agents and the reviewer |
| Your phone | `/comms-approve <code>` | Approves the waiting message with that code |

The five commands are files in `commands/`, marked `disable-model-invocation` so Claude can't run them; the mod answers each one itself. Agent and reviewer sessions get two tools, `comms_read` and `comms_post`. New messages arrive at the session's next step and wake it if it's idle.

## Settings

One setting, **Comms folder** (`userConfig` `folder`): where the channels and messages are kept. Leave it empty for `agent-comms` in your home folder. Change it in `/config`, or under `pluginConfigs` in `settings.json`. If you change it and use the web desk, start the desk with `AGENT_COMMS_ROOT` set to the same folder.

## Data handling

Everything stays on your computer. The plugin makes **no network requests**, **runs no programs**, uses no connectors or MCP servers, and collects nothing. Full policy: [PRIVACY.md](PRIVACY.md).

### What it sends, and where

Nothing leaves your computer through the plugin itself. The only way its data moves is into the Claude Code conversations you joined to it, described under [What it adds to a Claude conversation](#what-it-adds-to-a-claude-conversation). Those conversations are sent to Anthropic like anything you type.

### What it reads

- **The comms folder:** `channels.json` and the message, approval and decline files in it.
- **Its own store** (`$.store`): each session's identity, and the ids of messages already delivered, announced, held or used to wake it. In the desktop app these are kept under the app's session id, which lasts across restarts; in a terminal, under the transcript id. `/comms-as <agent>` takes over the records of that agent's earlier sessions, so nothing is delivered twice.
- **The conversation:** only through its own tools' calls (`comms_read`, `comms_post`) and the tool calls its guard checks. It reads no other files.
- **Environment:** `HOME` (macOS, Linux) or `USERPROFILE` (Windows), only to place the default comms folder; and `CLAUDE_CODE_HOST_SESSION_ID`, the desktop app's id for the session, so a session keeps its identity when it restarts. It reads no credentials, tokens or keys.

### What it writes

Only inside the comms folder, with the file API (`$.fs.write`):

- `channels.json`, when `/comms-setup`, `/comms-as <new agent>` or `/comms-group` adds a channel (existing entries are kept);
- one new JSON file per message in `channels/<channel>/messages/`, and per approval or decline in `approvals/` and `declined/`; none is ever edited or deleted;
- empty `.keep` files, which create the folders.

It never writes build, start-up, settings or instruction files, and it refuses to create the comms folder inside a git repository (it checks for a `.git` entry in the folder and the folders above it). A reader that catches a file mid-write sees JSON that doesn't parse yet; the plugin reads it again once it's complete.

### Programs it runs

None. Earlier versions ran `mv`, `rm`, PowerShell and `git`; everything they did is now done with the file API.

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
| `session.start` | Reads the Comms folder setting, restores the session's identity and starts polling the folder (every 15 s by default) |
| `command.run` (`comms-setup`, `comms-as`, `comms`, `comms-group`, `comms-approve`) | Answers the commands in `commands/` itself, so their text never reaches Claude. Each is refused unless you typed it yourself |
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

`claude plugin validate --strict .` and `claude plugin test .` (75 tests, including Windows paths). Needs Claude Code 2.1.293 or later.
