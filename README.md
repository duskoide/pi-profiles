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
pi install git:github.com/<you>/pi-profiles      # or npm:pi-profiles once published
pi -e /path/to/pi-profiles                       # or try it for one run
```

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
      "extensions": ["-builtin:mcp", "-builtin:codemode"]
    }
  }
}
```

- Only `packages` and `extensions` are profile-controlled; every other setting
  (theme, models, `defaultTools`, …) is left untouched.
- A missing `packages` or `extensions` key means an **empty** list.
- `keep` entries are re-appended to every switch (matched by string, or by
  `source` for object entries) so shared resources survive.
- Entry order is preserved verbatim — package order decides which extension wins
  a conflict.
- Entries are strings or objects shaped like settings entries:
  `source`, `autoload`, `extensions`, `skills`, `prompts`, `themes`.
  Unknown keys are rejected rather than silently dropped.
- A switch that would leave no packages **and** no extensions is refused unless
  you pass `--force`.

## Commands

| Command | Effect |
|---|---|
| `/profile` | pick a profile (no UI: list them) |
| `/profile <name>` | switch and reload |
| `/profile list` | list profiles, marking the active one |
| `/profile save <name> [--force]` | snapshot the current `packages` + `extensions` |
| `/profile undo` | restore the set from before the last switch |
| `/profile rm <name>` | delete a profile (refuses the active one) |

## Launch with a profile

The CLI applies the profile before starting Pi, so the very first load already
has the right set:

```bash
pi-profile work                       # switch, then start pi
pi-profile work -- --model opus       # extra pi args after --
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
  symlink a symlink, and mirrors whether the file ended with a newline.
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
3. **Project settings still merge on top.** A project `.pi/settings.json` can add
   packages/extensions a profile cannot remove. Use `-path`/`!pattern` entries there
   if that matters.
4. **Keep editing conflict-free.** `pi config` writes the same file; don't run it
   while a switch is in flight. The write is serialized per path inside one
   process, not across processes.
5. **`previous` holds one level only**, and is overwritten by each switch.

## Development

```bash
npm test
```

Tests use Node's type stripping (Node ≥ 22.18) and a stub for
`@earendil-works/pi-coding-agent`, so nothing has to be installed.
