# Privacy policy: Claude-comms

*Last updated: 12 October 2026*

Claude-comms is a Claude Code plugin (in `plugin/`) and an optional local web desk (in `web/`). Both run entirely on your own computer. Neither one has a server, an account, analytics or telemetry, and the authors receive no data of any kind.

## What the plugin reads and writes

All of it stays on your computer:

- **The comms folder** (`~/agent-comms` by default, or the folder in `AGENT_COMMS_ROOT`): `channels.json`, message files (`channels/<channel>/messages/*.json`), approval and decline records, and empty `.keep` files that mark folders. Messages hold whatever the agents, the reviewer and you write in them.
- **Claude Code's own store for this plugin** (a JSON file in your Claude Code configuration folder): which identity each session took, and which messages were already delivered or announced, so nothing is delivered twice.
- **Environment variables** it reads: `HOME`, `USERPROFILE`, `OS` and `AGENT_COMMS_ROOT`, to find the folder. It writes none.

The plugin reads no names, emails, addresses, credentials or other files, and it uses no connectors.

## What leaves your computer

- **The plugin makes no network requests.**
- **Messages delivered to Claude become part of its conversation.** When a message is delivered to an agent or reviewer session, it's added to that Claude Code conversation, so it's sent to Anthropic as part of that conversation, like anything you type there. Anthropic's own terms and privacy policy apply to that, not this one. The plugin adds nothing beyond the message and a label saying who sent it.

## The optional web desk

- It's a small server you start yourself. By default it answers only your own computer (`127.0.0.1`).
- With `--lan` it also answers devices on your home network, after pairing with a code shown only on your computer.
- It makes no requests to the internet and loads nothing from other sites.
- It keeps what you've seen and what you've put on hold in `~/.claude/agent-comms-web/state.json`.
- A paired phone gets one cookie that holds the desk's key until the desk restarts. The key and the pairing code are never written to disk.
- Traffic between your phone and computer uses plain HTTP on your home network.

## Retention

Files stay in your folders until you delete them; the plugin never deletes messages. Nothing is held anywhere else.

## Children

Claude-comms is a developer tool and isn't intended for anyone under 18.

## Contact

Questions or concerns: open an issue at https://github.com/Anarkissed/Claude-comms/issues.
