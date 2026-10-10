# Claude-comms plugin (Claude Code)

The Claude Code half of [Claude-comms](../README.md): a plugin of function hooks (its internal name is `agent-comms`). Load this folder with `CLAUDE_CODE_PLUGIN_DIRS` (see the main README).

It gives each session an identity (`/comms-as`) and:
- **agent and reviewer sessions:** polling, delivery of messages at a step boundary, auto-wake when idle, a status line, and the `comms_read` / `comms_post` tools;
- **your maintainer session:** the `/comms` pane;
- **every session:** a `tool.call` guard so no model writes the comms folder except through `comms_post`.

Commands: `/comms-setup`, `/comms-as <id|off>`, `/comms`, `/comms-group <name> <agent> <agent> …`, `/comms-approve <code>`.

Settings come from the environment: `AGENT_COMMS_ROOT` (the folder; default `~/agent-comms`). Everything else is in `channels.json`.

Tests: `claude plugin test .`. A test seam, `AGENT_COMMS_TEST_DELIVERY_SINK=1`, routes delivery to the debug log, because the test kit cannot stand in for `session.append`. Never set it in a real session.
