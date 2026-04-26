# Maintenance commands

Reversal, re-execution, configuration, and housekeeping.

## Reversal

| Command | Behavior |
|---|---|
| `undo` | Semantic reversal via worker. Reads most recent run artifact and asks the worker to undo. See [../prediction/undo-and-revert.md](../prediction/undo-and-revert.md). |
| `revert <source>` | Reverts revertable commits via `GitClient` and unchecks the corresponding boxes. |

## Re-execution

| Command | Behavior |
|---|---|
| `reverify <source>` | Re-runs verification on completed tasks. Refreshes the `<file>.<index>.validation` sidecar. |
| `repair <source>` | Runs a repair pass on a task with a failed validation, without re-executing the original task. |

## Locks

| Command | Behavior |
|---|---|
| `unlock <source>` | Releases the source-relative lockfile. Validates pid/host metadata. |

## Project init

| Command | Behavior |
|---|---|
| `init` | Creates `<cwd>/.rundown/` and an empty `config.json` (`{}`). With `--worker <argv>`, also writes `workers.default`. |
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

All accept `--scope local\|global` (defaults to local).

## Workspace

[src/application/workspace-lifecycle.ts](../../implementation/src/application/workspace-lifecycle.ts).

`workspace` manages linked workspace metadata (when `start` or `init` records cross-directory links between `design/`, `migrations/`, `specs/`, and the implementation folder).

| Subcommand | Effect |
|---|---|
| `workspace unlink` | Drop the active link |
| `workspace remove` | Remove a workspace entry by id |

## Memory

| Command | Effect |
|---|---|
| `migrate memory-clean` | Prune entries no longer relevant |
| `migrate memory-validate` | Validate entries against current state |
| `migrate memory-view` | Print current memory contents |

(Top-level memory inspection is provided through `migrate memory-*`; project-level memory writes happen through the `memory:` built-in tool during runs.)

## Worker health

[src/application/worker-health-status.ts](../../implementation/src/application/worker-health-status.ts).

| Command | Effect |
|---|---|
| `worker-health` | Print health status (`healthy`/`cooling_down`/`unavailable`) for each known worker |
| `worker-health --reset` | Clear sticky `unavailable` entries |
