# Privacy policy: agent-comms (Claude-comms plugin)

*Last updated: 14 October 2026*

agent-comms is a Claude Code plugin. It runs entirely on your own computer, in Claude Code in the Claude desktop app, the terminal or an IDE. It has no server, account, analytics or telemetry, and the authors receive no data of any kind.

## What it reads and writes

All of it stays on your computer:

- **The comms folder** (`agent-comms` in your home folder by default, or the plugin's **Comms folder** setting): `channels.json`, message files (`channels/<channel>/messages/*.json`), and approval, decline and hold records. Messages hold whatever the agents, the reviewer and you write in them. It writes nothing outside this folder.
- **Claude Code's own store for this plugin** (a JSON file in your Claude Code configuration folder): which identity each session took, and which messages were already delivered or announced, so nothing is delivered twice.
- **Environment variables** it reads: `HOME` or `USERPROFILE`, to place the default folder, to expand `~` in the folder setting and in the paths its guard checks, and to find its store folder; `CLAUDE_CODE_HOST_SESSION_ID`, so a desktop session keeps its identity across restarts; and `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION`, to tell a `claude` started from another session's shell. It reads no credentials and writes no variables. The session id is an identifier, not a secret, and is used only as a key in the plugin's own store; it is never sent anywhere.
- **The conversation's rows**, at the start of a turn that may follow a rewind (one that adds no new prompt of yours) and when a desktop session comes back under a new transcript, to find its own delivery headers and deliver again what a rewind took out. Nothing is copied anywhere.
- **Its earlier store file**, when it was used before as a folder-loaded copy: it lists Claude Code's plugin store folder (`~/.claude/plugins/store/`) to find `agent-comms_inline-*.json` and reads only that file, to carry its own session records over. It reads no other file there.
- **Programs:** it runs none.

The plugin reads no names, emails, addresses, credentials or other files, and it uses no connectors or MCP servers.

## What leaves your computer

- **The plugin makes no network requests.**
- **Messages delivered to Claude become part of its conversation.** When a message is delivered to an agent or reviewer session, it's added to that Claude Code conversation, with a short auto-wake note if the session was idle. So it's sent to Anthropic as part of that conversation, like anything you type there. Anthropic's own terms and privacy policy apply to that, not this one. The plugin adds nothing beyond the message, a label saying who sent it, that note, the results of its own `comms_read` and `comms_post` tools, and the text of its refusals when the model tries to write to the comms folder another way (which name the folder's path). Exact texts in [README.md](README.md#what-it-adds-to-a-claude-conversation).

## Retention

Files stay in your folders until you delete them; the plugin never deletes messages. Nothing is held anywhere else.

## Children

agent-comms is a developer tool and isn't intended for anyone under 18.

## Contact

Questions or concerns: open an issue at https://github.com/Anarkissed/Claude-comms/issues.
