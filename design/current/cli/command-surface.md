# Command surface

Full list of top-level commands. Detailed contracts in the topic files.

This list is the authoritative inventory of every `program.command(...)` registration in [src/presentation/cli.ts](../../implementation/src/presentation/cli.ts). When a command is added, removed, or renamed there, this table must change in the same PR.

## Execution

| Command | Purpose |
|---|---|
| `run <source>` | Execute the next runnable task (or all with `--all`) |
| `materialize <source>` | `run --all --revertable` for collapsing prediction onto reality |
| `call <source>` | Run a single named task by index or text match |
| `do <seed-text> <markdown-file>` | Bootstrap with `make`, then execute all generated tasks against the same file |
| `loop <source>` | Repeatedly run until source is fully checked or errors |
| `all <source>` | Implicit-all alias used inside seed files |

## Planning, research, scaffolding

| Command | Purpose |
|---|---|
| `plan <source>` | Scan-based TODO generation with convergence |
| `add <seed-text> <markdown-file>` | Append seed text to an existing doc, then run `plan` |
| `make <seed-text> <markdown-file>` | Create a new task doc from seed text, then run research + plan |
| `explore <source>` | Combined research + plan pass |
| `research <source>` | Research worker invocation; produces output without executing tasks |
| `query <text>` | Non-interactive single-turn worker query (codebase research + plan + execute) |
| `translate <what> <how> <output>` | Re-express one Markdown document using the vocabulary of another |

## Prediction lifecycle

| Command | Purpose |
|---|---|
| `start "<description>"` | Scaffold a prediction-oriented project |
| `migrate` | Convergence loop: planner → migration files |
| `design release` | Snapshot `design/current/` → `design/rev.N/` |
| `design diff [target]` | Compare revisions |
| `test [action] [prompt]` | Verify specs in the current materialized workspace; `test new "<prompt>"` creates a new spec assertion |

## Review

| Command | Purpose |
|---|---|
| `discuss <source>` | Interactive TUI session against a file |
| `next <source>` | Show what the next runnable task would be |
| `list <source>` | List tasks (`--all` to include checked) |
| `log` | Show run history and traces |
| `artifacts` | List, prune, or open saved runtime-artifact run directories |

## Maintenance

| Command | Purpose |
|---|---|
| `undo` | Semantic reversal of last task outcome |
| `revert` | Revert revertable task commits (selects runs via `--run`/`--last`/`--all`) |
| `reverify` | Re-run verification on completed tasks (selects runs via `--run`/`--last`/`--all`) |
| `unlock <source>` | Release stuck file locks |
| `init` | Initialize `.rundown/` in current project |
| `localize` | Localize `.rundown/` templates and locale aliases |
| `with <harness>` | Configure worker harness preset |
| `config <action>` | Get/set/unset/list config keys (`--scope local\|global`); also `config path` |
| `workspace <action>` | Manage linked workspace metadata (`unlink`, `remove`) |
| `worker-health` | Show worker health status |
| `memory-view <source>` | Display source-local memory entries |
| `memory-validate <source>` | Validate source-local memory consistency |
| `memory-clean <source>` | Remove orphaned, outdated, or invalid memory |

## Global

| Flag | Purpose |
|---|---|
| `--config-dir <path>` | Explicit `.rundown/`, bypasses upward discovery |
| `--agents` | Print AGENTS.md guidance to stdout (root-level only) |
| `-c, --continue` | Resume the previous interactive root help/agent session |
