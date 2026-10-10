# Publishing notes: Anthropic's plugin directory

How `plugin/` is kept ready for the directory at claude.ai/directory/manage. Checked 10 October 2026 against Anthropic's docs: [Submit your plugin](https://claude.com/docs/plugins/submit), the [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist), the [manifest reference](https://code.claude.com/docs/en/plugins-reference) and the [mods reference](https://code.claude.com/docs/en/plugins/mods/reference).

## Submission

- **Repository** `Anarkissed/Claude-comms`, **plugin path** `plugin`, branch `main`. The directory reads and scans only that folder.
- Run `claude plugin validate --strict plugin` and `claude plugin test plugin` with Claude Code 2.1.293 or later first; older versions report false errors.
- Raise `version` in `plugin/.claude-plugin/plugin.json` with every release.

## What the directory requires, and where it's met

| Requirement | Where |
|---|---|
| `.claude-plugin/plugin.json` with name, description, author, version | `plugin/.claude-plugin/plugin.json` |
| README of 40+ words in the plugin folder | `plugin/README.md` |
| Licence | `plugin/LICENSE`, and `"license": "MIT"` |
| Listing links | `homepage`, `repository`, `documentationUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`, `supportUrl` in `plugin.json`, pointing at `plugin/README.md`, `plugin/PRIVACY.md`, `plugin/TERMS.md` and the issues page |
| Icon | `plugin/icon.svg` (SVG is accepted) |
| No `.DS_Store`, binaries, symlinks; files under 256 KiB; 512 files or fewer | Checked |
| Commands listed | `plugin/commands/*.md`. The listing only reads that folder; commands a mod registers in code aren't listed. Each file has `disable-model-invocation: true`, and the mod answers it in `command.run` (plain name and `agent-comms:` name) without calling `next`, so the file's text never reaches Claude |
| Say what it runs, sends and submits | `plugin/README.md`, "Data handling" |

## Findings that can't be cleared, and why

- **Listed on Claude Code only.** The directory lists mods for Claude Code only; the Cowork and Claude apps boxes are greyed out for every mod. Claude Code includes the Claude desktop app's Code tab, the terminal and the IDE extensions.
- **"Mod can read the conversation … and can submit a prompt"** (auto-wake) and **"can read local data and can also send data out"** (delivery): these are what the plugin is for. They're reviewer holds, not blocks; the README quotes the exact text of every prompt and delivery.
- **"Uses a credential from the user's machine"**: the plugin reads only `HOME` / `USERPROFILE`, to place the default folder. It's unrelated to anything sent, so a reviewer can confirm it.
- **"Unrecognized field in plugin.json"** (warnings) and **"Field from another tool's manifest: icon"** (no action): the directory link fields and `types` are read by the directory or by mods, not by Claude Code's loader. Keep them.

## Changes made to clear holds

- No programs: `mv`, `rm`, PowerShell and `git` were replaced with Claude Code's file API (`$.fs.write`, `$.fs.exists`). Readers re-read a file caught mid-write.
- No environment reads besides `HOME` / `USERPROFILE`: the folder is the `userConfig` setting `folder` ("Comms folder"), and the test-only `AGENT_COMMS_TEST_DELIVERY_SINK` is gone (the 2.1.293 test kit stubs `session.append`).
