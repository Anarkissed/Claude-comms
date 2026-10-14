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
- **"Uses a credential from the user's machine"**: the directory flags any environment read besides `HOME` / `USERPROFILE`. Since the #362 fix the plugin also reads `CLAUDE_CODE_HOST_SESSION_ID` (the desktop app's id for a session, so a session keeps its identity across restarts) and `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` (only whether they are set, so a `claude` started from a session's shell doesn't take its identity). None is a secret, and none is sent anywhere: the id is only a key in the plugin's local store. Decision of 14 October 2026: keep them and let a reviewer confirm; the README's "Credentials" section says so.
- **"Unrecognized field in plugin.json"** (warnings) and **"Field from another tool's manifest: icon"** (no action): the directory link fields and `types` are read by the directory or by mods, not by Claude Code's loader. Keep them.

## Changes made to clear holds

- No programs: `mv`, `rm`, PowerShell and `git` were replaced with Claude Code's file API (`$.fs.write`, `$.fs.exists`). Readers re-read a file caught mid-write.
- No environment reads besides `HOME` / `USERPROFILE` (as of 10 October 2026; the #362 fix later added three, kept on purpose, see above): the folder is the `userConfig` setting `folder` ("Comms folder"), and the test-only `AGENT_COMMS_TEST_DELIVERY_SINK` is gone (the 2.1.293 test kit stubs `session.append`).

## Review of v0.1.0 (14 October 2026) and what changed in v0.2.0

The directory's code checker behaves like Claude Code **2.1.278**: that version prints the same manifest warnings, and its hooks check refuses what newer versions accept. Validate with both:

```bash
claude plugin validate plugin          # 2.1.278 on PATH: must pass (warnings only for the listing fields)
"$HOME/Library/Application Support/Claude/claude-code/2.1.295/9d6405864fdc/claude.app/Contents/MacOS/claude" plugin validate --strict plugin
```

| Finding | Resolution in v0.2.0 |
|---|---|
| **Error: "Mod uses $ or on in a way the directory couldn't follow"** (`hooks/register.tsx` 264–266) | 2.1.278 refuses `$` passed to `read` / `update` imported from `claude-code` ("$ is followed only into a function declared in this same file"). Every state value now has its own `get…` / `set…` function in `register.tsx`, calling `$.state.get` / `$.state.set` with its `{ plugin, key }` written out. `quietly` is a function declaration above `init`, and the flagged lines call nothing nested inside a `$` call. |
| "Mod writes a file that other tools run or obey" (the `.keep` write) | The empty `.keep` files are gone; a channel's folders come into being with its setup note. The README lists every path the plugin writes, all inside the comms folder, and says it never writes build, start-up, settings or instruction files. |
| "Mod can read the conversation … and can also submit a prompt" | README section "Prompts it submits": the auto-wake prompt is the only one, and it holds only a count, channel names and sender ids. |
| "Uses a credential from the user's machine" | Kept, reviewer confirms (see above). README section "Credentials". |
| "Unrecognized field in plugin.json" (5) / "Field from another tool's manifest: icon" | Keep: the directory reads these listing fields itself; 2.1.278 just predates them (2.1.281 knows them). |
| "Validation didn't finish on this commit" | Nothing to change; resubmitted with the error fixed. |
