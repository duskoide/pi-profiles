# pi-profiles

Hot-swappable extension profiles for [Pi](https://pi.dev): swap the whole extension
set with one command — `/profile work` in a session, `pi-profile work` at launch.

A profile is just the pair of resource lists that decide what Pi loads:
`packages` and `extensions`. Switching rewrites those two keys in
`settings.json` and reloads the extension runtime. Pi's reload re-reads settings
and re-resolves packages, so the new set loads and the old one is discarded —
the session and its transcript are preserved.

```
 pi> /profile work
 profile "work" active (9 packages, 3 extensions) — reloading
```

## Install

```bash
pi install npm:pi-profiles                       # from npm
pi install git:github.com/duskoide/pi-profiles      # or from git
pi -e /path/to/pi-profiles                       # or try it for one run

npm i -g pi-profiles                             # optional: the pi-profile launcher
```

The core (`src/profiles-core.js`) is plain JavaScript, so the `pi-profile`
launcher runs on Node ≥ 20 from anywhere, including `node_modules` (Node
refuses to strip TypeScript types there). The extension entry stays `.ts`;
Pi loads it with its own loader.

Then make the switcher survive its own switches: put whatever loads it in `keep`
(see below). Without that, a profile that omits this package removes `/profile`.

## Configure

Profiles live in `~/.pi/agent/pi-profiles.json` (override with `PI_PROFILES_FILE`):

```json
{
  "version": 1,
  "active": "work",
  "keep": {
    "packages": ["./pi-config"],
    "extensions": []
  },
  "profiles": {
    "work": {
      "description": "everything, codemode only",
      "packages": ["npm:pi-web-access", "npm:@mostlyworks/pi-delegator@0.6.6", "./pi-config"],
      "extensions": ["-builtin:mcp"]
    },
    "minimal": {
      "description": "no third-party extensions",
      "packages": ["./pi-config"],
      "extensions": ["-builtin:mcp", "-builtin:codemode"],
      "appendSystemPrompt": "Keep answers short; no third-party tools are loaded."
    },
    "clean": {
      "description": "plain pi, built from scratch",
      "agentDir": "~/.pi/profiles/clean",
      "share": ["auth.json"]
    },
    "review": {
      "packages": ["./pi-config"],
      "appendSystemPromptFile": "prompts/review.md"
    }
  }
}
```

- A profile can append to Pi's system prompt while it is active:
  `appendSystemPrompt` (inline text) or `appendSystemPromptFile` (path, `~`
  allowed, relative to the profiles file's directory) — not both. The text goes
  after Pi's own append text (`APPEND_SYSTEM.md` / `--append-system-prompt`).
  The file is re-read every turn, so edits apply without a reload; a missing
  file shows a warning once and the turn proceeds without it.
  The profile is pinned when the extension loads, so a switch in another session
  only changes this session's prompt when it reloads, together with its
  extension set. Prompt appending requires this extension to be loaded (keep it
  in `keep`); the `pi-profile` launcher just switches, Pi applies the prompt.
- Only `packages` and `extensions` are written to `settings.json`; every other setting
  (theme, models, `defaultTools`, …) is left untouched.
- A missing `packages` or `extensions` key means an **empty** list.
- `keep` entries are always present after a switch. They are matched to profile
  entries by package identity (`source`, ignoring npm versions and git refs, so
  `npm:x@1.2` matches `npm:x`). If a profile names the same package, the keep
  entry **replaces** it in place (and a warning is shown when they differed,
  e.g. a profile that filtered out `/profile`). Otherwise it is appended.
- Profile names and definitions are validated when the file is read; one bad
  profile makes every command fail with a message naming it.
- Entry order is preserved verbatim — package order decides which extension wins
  a conflict.
- Entries are strings or objects shaped like settings entries:
  `source`, `autoload`, `extensions`, `skills`, `prompts`, `themes`.
  Unknown keys are rejected rather than silently dropped.
- A switch that would leave no packages **and** no extensions is refused unless
  you pass `--force`.

## Isolated profiles (a separate, from-scratch Pi)

A profile with `agentDir` does not touch `settings.json`. Instead
`pi-profile <name>` starts Pi with `PI_CODING_AGENT_DIR` pointing at that
folder, so it sees **none** of the main setup: no settings, packages,
`extensions/`, skills, prompts, themes, `APPEND_SYSTEM.md`, global
`AGENTS.md`, MCP servers, models or sessions. Build it up from inside with
`pi install …` and `/settings` as if Pi were freshly installed.

- `agentDir`: `~` allowed; relative paths resolve against the profiles file's
  directory. Created on first launch. It may not be the main agent dir.
- `share` (default `["auth.json"]`): files or folders symlinked from the main
  agent dir so you stay logged in. Add `"models.json"` for custom providers.
  Existing files in the profile dir are never replaced.
- Only `description`, `agentDir`, `share` are allowed on such a profile.
- It needs a fresh process: `/profile clean` inside Pi just tells you to run
  `pi-profile clean`. In the picker it shows as `clean (separate pi)`.
- Launching it does not change `active`/`previous`; `rm` removes the
  definition but keeps the folder.
- `pi-profile` run from inside an isolated Pi still manages the main setup.
- Not isolated by design: project `.pi/` files and `AGENTS.md`/`CLAUDE.md` in
  the working directory and its parents (Pi loads those per project), and
  environment variables such as API keys.

## Commands

| Command | Effect |
|---|---|
| `/profile` | pick a profile; the active one is marked (no UI: list them) |
| `/profile <name>` | switch and reload |
| `/profile list` | list profiles, marking the active one |
| `/profile save <name> [--force]` | snapshot the current `packages` + `extensions` |
| `/profile undo` | restore the set from before the last switch (repeat to toggle back) |
| `/profile rm <name>` | delete a profile (refuses the active one) |

## `pi --profile <name>`

Pi can't take this as its own flag: extension flags are parsed after extensions
load, and an isolated profile needs `PI_CODING_AGENT_DIR` set before Pi starts.
So pi-profiles ships a tiny `pi` shell function instead:

```bash
# ~/.zshrc or ~/.bashrc
eval "$(pi-profile shell-init)"
# fish: pi-profile shell-init fish | source
# not on PATH (installed via pi install)? use the script path:
# eval "$(node /path/to/pi-profiles/bin/pi-profile.mjs shell-init)"
```

```bash
pi --profile work --model opus   # switch, then start pi with the rest of the args
pi --profile=clean               # isolated profile
pi --profile                     # list
pi -p "hi"                       # anything else: the real pi, untouched
```

`--profile` must be the first argument. The function only wraps interactive
shells; scripts calling `pi` get the real binary.

## Launch with a profile

The CLI applies the profile before starting Pi, so the very first load already
has the right set:

```bash
pi-profile work                       # switch, then start pi
pi-profile work --model opus          # other args go to pi
pi-profile work -- --force            # use -- for args pi-profile would claim
pi-profile work --no-exec             # switch only
pi-profile save laptop --force
pi-profile undo
```

| Env | Default | Meaning |
|---|---|---|
| `PI_PROFILES_FILE` | `~/.pi/agent/pi-profiles.json` | profile definitions |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config directory |
| `PI_BIN` | `pi` | executable the launcher starts |

A `--profile` *Pi* flag is intentionally not provided: Pi applies extension flag
values only after extensions load, so it could not change the set for the
current process. The launcher does the write before `pi` starts instead.

## What a switch does to your files

- `settings.json`: only `packages` and `extensions` change. The write is atomic
  (temp file + rename onto the resolved path), preserves the file mode, keeps a
  symlink a symlink, and keeps the existing indentation and trailing newline.
- Every mutation takes a cross-process lock (`<file>.lock` directory, the
  proper-lockfile convention Pi itself uses on `settings.json`), so it never
  interleaves with Pi's own settings writes, another session, or the CLI.
- `settings.json` is written first, then `pi-profiles.json`; if the second
  write fails the original settings text is restored.
- `pi-profiles.json`: `active` and a single `previous` snapshot are updated.
  That snapshot is what `/profile undo` restores.
- Missing or unparseable `settings.json` is never overwritten: a broken file
  aborts the switch.

## Caveats

1. **Reload keeps the session, not extension state.** Anything an extension held
   in memory is gone after a switch; persist to disk or `pi.appendEntry()`.
2. **Packages are resolved from disk on reload.** A package that is not installed
   yet is installed during the reload (needs network; skipped when offline), so
   the first switch to a profile with a new package can pause.
3. **Profiles are global.** `settings.json` is shared by every Pi session. Other
   running sessions keep their current set until they reload or restart, then
   pick up the new one. Pi only writes back the settings fields a session
   changed, so a normal settings change elsewhere (model, theme) does not undo a
   switch — but `pi install`/`pi remove` in a stale session rewrites
   `packages` from its own view.
4. **Project settings still merge on top.** A project `.pi/settings.json` can add
   packages/extensions a profile cannot remove. Use `-path`/`!pattern` entries there
   if that matters.
5. **`previous` holds one level.** Undo swaps current and previous; it is not a
   history.

## Development

```bash
npm test
```

Tests load the `.ts` extension via Node's type stripping (Node ≥ 22.18; runtime needs only Node ≥ 20) and a stub for
`@earendil-works/pi-coding-agent`, so nothing has to be installed.
