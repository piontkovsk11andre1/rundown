# Maintenance commands

Reversal, re-execution, configuration, and housekeeping.

## Reversal

| Command | Behavior |
|---|---|
| `undo` | Semantic reversal via worker. Reads most recent run artifact and asks the worker to undo. See [../prediction/undo-and-revert.md](../prediction/undo-and-revert.md). |
| `revert` | Reverts revertable commits via `GitClient` and unchecks the corresponding boxes. Targets are selected by run id (`--run`, `--last <n>`, or `--all`); there is no positional source argument. |

## Re-execution

| Command | Behavior |
|---|---|
| `reverify` | Re-runs verification on completed runs from saved artifacts. Refreshes the `<file>.<index>.validation` sidecar. Targets are selected by run id (`--run`, `--last <n>`, or `--all`); there is no positional source argument. Repair attempts are reused on failure unless `--no-repair` is set. |

There is no top-level `repair` command; repair is a phase **inside** `run` / `reverify` (see [../execution/verify-repair-loop.md](../execution/verify-repair-loop.md)).

## Locks

| Command | Behavior |
|---|---|
| `unlock <source>` | Releases the source-relative lockfile. Validates pid/host metadata. |

## Project init

| Command | Behavior |
|---|---|
| `init` | Creates `<cwd>/.rundown/` and an empty `config.json` (`{}`). With `--default-worker <command>` / `--tui-worker <command>`, also writes the matching keys. `--language <lang>` runs localization after init; `--gitignore` adds `.rundown` to `.gitignore`. |
| `localize` | Re-localizes templates and locale intent aliases for an existing `.rundown/`. Optional `--language <lang>` selects the target language. See [../configuration/locale.md](../configuration/locale.md). |
| `start "<desc>"` | Higher-level scaffolder; see [prediction-commands.md](prediction-commands.md). |
| `with <harness>` | Writes preset keys for a known harness. See [../workers/harness-presets.md](../workers/harness-presets.md). |

## Config

[src/application/config-mutation.ts](../../implementation/src/application/config-mutation.ts).

| Subcommand | Effect |
|---|---|
| `config get <key>` | Print value at dotted path |
| `config set <key> <value>` | Set value (JSON literal) at path |
| `config unset <key>` | Remove key at path |
| `config list` | Dump effective config |
| `config path` | Print absolute path of the in-effect config file |

Read-style subcommands (`get`, `list`, `path`) accept `--scope effective|local|global` and default to `effective`. Write-style subcommands (`set`, `unset`) accept `--scope local|global` and default to `local`. `get` and `list` also accept `--json` and `--show-source`; `set` accepts `--type auto|string|number|boolean|json`.

## Workspace

[src/application/workspace-lifecycle.ts](../../implementation/src/application/workspace-lifecycle.ts).

`workspace` manages linked workspace metadata (when `start` or `init` records cross-directory links between `design/`, `migrations/`, `specs/`, and the implementation folder).

| Subcommand | Effect |
|---|---|
| `workspace unlink` | Drop the active link |
| `workspace remove` | Remove a workspace entry by id |

## Artifacts

[src/application/manage-artifacts.ts](../../implementation/src/application/manage-artifacts.ts).

| Command | Effect |
|---|---|
| `artifacts` | List saved runtime-artifact runs |
| `artifacts --failed` | Show only failed runs |
| `artifacts --json` | Emit machine-readable JSON |
| `artifacts --open <runId\|prefix\|latest>` | Open the saved run directory |
| `artifacts --clean` | Remove all saved runs |

## Memory

Memory inspection commands are top-level (not nested under `migrate`). They operate on source-local memory under `<source-dir>/.rundown/memory/`.

| Command | Effect |
|---|---|
| `memory-view <source>` | Print memory entries (or summaries with `--summary`) for the matched files. `--all` includes every file the source resolves to. |
| `memory-validate <source>` | Validate memory consistency. `--fix` auto-repairs recoverable issues. |
| `memory-clean <source>` | Remove orphaned, outdated, or invalid entries. Selectors: `--orphans`, `--outdated --older-than <duration>`, `--all`. `--dry-run` previews. |

Project-level memory **writes** happen through the `memory:` built-in tool during runs (see [../builtin-tools/memory.md](../builtin-tools/memory.md)).

## Worker health

[src/application/worker-health-status.ts](../../implementation/src/application/worker-health-status.ts).

| Command | Effect |
|---|---|
| `worker-health` | Print health status (`healthy`/`cooling_down`/`unavailable`) for each known worker (`--json` for machine-readable output) |
