# Privacy policy: agent-comms (Claude-comms plugin)

*Last updated: 10 October 2026*

agent-comms is a Claude Code plugin. It runs entirely on your own computer, in Claude Code in the Claude desktop app, the terminal or an IDE. It has no server, account, analytics or telemetry, and the authors receive no data of any kind.

## What it reads and writes

All of it stays on your computer:

- **The comms folder** (`agent-comms` in your home folder by default, or the plugin's **Comms folder** setting): `channels.json`, message files (`channels/<channel>/messages/*.json`), approval and decline records, and empty `.keep` files that mark folders. Messages hold whatever the agents, the reviewer and you write in them.
- **Claude Code's own store for this plugin** (a JSON file in your Claude Code configuration folder): which identity each session took, and which messages were already delivered or announced, so nothing is delivered twice.
- **Environment variables** it reads: `HOME` or `USERPROFILE`, only to place the default folder. It reads no credentials and writes no variables.
- **Programs:** it runs none.

The plugin reads no names, emails, addresses, credentials or other files, and it uses no connectors or MCP servers.

## What leaves your computer

- **The plugin makes no network requests.**
- **Messages delivered to Claude become part of its conversation.** When a message is delivered to an agent or reviewer session, it's added to that Claude Code conversation, with a short auto-wake note if the session was idle. So it's sent to Anthropic as part of that conversation, like anything you type there. Anthropic's own terms and privacy policy apply to that, not this one. The plugin adds nothing beyond the message, a label saying who sent it, and that note (exact text in [README.md](README.md#what-it-adds-to-a-claude-conversation)).

## Retention

Files stay in your folders until you delete them; the plugin never deletes messages. Nothing is held anywhere else.

## Children

agent-comms is a developer tool and isn't intended for anyone under 18.

## Contact

Questions or concerns: open an issue at https://github.com/Anarkissed/Claude-comms/issues.
