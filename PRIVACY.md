# Privacy policy: Claude-comms

*Last updated: 14 October 2026*

Claude-comms is a Claude Code plugin (in `plugin/`) and an optional local web desk (in `web/`). Both run entirely on your own computer. Neither one has a server, an account, analytics or telemetry, and the authors receive no data of any kind.

## What the plugin reads and writes

All of it stays on your computer:

- **The comms folder** (`~/agent-comms` by default, or the plugin's **Comms folder** setting): `channels.json`, message files (`channels/<channel>/messages/*.json`), and approval, decline and hold records. Messages hold whatever the agents, the reviewer and you write in them. The plugin writes nothing outside this folder.
- **Claude Code's own store for this plugin** (a JSON file in your Claude Code configuration folder): which identity each session took, and which messages were already delivered or announced, so nothing is delivered twice. If the plugin was used before as a folder-loaded copy, it also lists the store folder to find that copy's `agent-comms_inline-*.json` file and reads only that file, to carry its own records over.
- **Environment variables** it reads: `HOME` or `USERPROFILE` (to place the default folder, to expand `~` in the Comms folder setting and in paths its guard checks, and to find its store folder); `CLAUDE_CODE_HOST_SESSION_ID`, the desktop app's id for a session (an identifier, not a secret), so a session keeps its identity across restarts; and `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION`, only whether they are set. It reads no credentials and writes no variables.
- **The conversation's rows**, at the start of a turn that may follow a rewind, to find its own delivery headers and deliver again what a rewind took out. Nothing it reads there is copied anywhere.
- **Programs:** it runs none.

The plugin reads no names, emails, addresses, credentials or other files, and it uses no connectors.

## What leaves your computer

- **The plugin makes no network requests.**
- **Messages delivered to Claude become part of its conversation.** When a message is delivered to an agent or reviewer session, it's added to that Claude Code conversation, so it's sent to Anthropic as part of that conversation, like anything you type there. Anthropic's own terms and privacy policy apply to that, not this one. The plugin adds nothing beyond the message, a label saying who sent it, a short auto-wake note when the session was idle (it names only the channel and the sender), the results of its own `comms_read` and `comms_post` tools, and the text of its refusals when the model tries to write to the comms folder another way (which name the folder's path). The exact texts are in [plugin/README.md](plugin/README.md#what-it-adds-to-a-claude-conversation).

## The optional web desk

- It's a small server you start yourself. By default it answers only your own computer (`127.0.0.1`).
- With `--lan` it also answers devices on your home network, after pairing with a code shown only on your computer.
- It makes no requests to the internet and loads nothing from other sites.
- It keeps which messages you've seen in `~/.claude/agent-comms-web/state.json`. Holds are files in the comms folder (`held/`), shared with the plugin's pane.
- A paired phone gets one cookie that holds the desk's key until the desk restarts. The key and the pairing code are never written to disk.
- Traffic between your phone and computer uses plain HTTP on your home network.

## Retention

Files stay in your folders until you delete them; the plugin never deletes messages. Nothing is held anywhere else.

## Children

Claude-comms is a developer tool and isn't intended for anyone under 18.

## Contact

Questions or concerns: open an issue at https://github.com/Anarkissed/Claude-comms/issues.
