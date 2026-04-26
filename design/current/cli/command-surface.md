# Command surface

Full list of top-level commands. Detailed contracts in the topic files.

## Execution

| Command | Purpose |
|---|---|
| `run <source>` | Execute the next runnable task (or all with `--all`) |
| `materialize <source>` | `run --all --revertable` for collapsing prediction onto reality |
| `call <source>` | Run a single named task by index or text match |
| `do <task-text>` | One-off inline task without a file |
| `loop <source>` | Repeatedly run until source is fully checked or errors |
| `all <source>` | Implicit-all alias used inside seed files |

## Planning and research

| Command | Purpose |
|---|---|
| `plan <source>` | Scan-based TODO generation with convergence |
| `research <source>` | Research worker invocation; produces output without executing tasks |
| `explore <source>` | Combined plan + research pass |
| `query <source>` | Non-interactive single-turn worker query |
| `translate <what>` | Localize / translate operation |

## Prediction lifecycle

| Command | Purpose |
|---|---|
| `start "<description>"` | Scaffold a prediction-oriented project |
| `migrate` | Convergence loop: planner → migration files |
| `migrate up` | Execute pending migrations, write `N.1 Snapshot.md` |
| `migrate down [n]` | Remove last `n`, prune snapshots, regenerate |
| `migrate memory-clean` | Prune outdated memory entries |
| `migrate memory-validate` | Validate memory against state |
| `migrate memory-view` | Read current memory |
| `design release` | Snapshot `design/current/` → `design/rev.N/` |
| `design diff [target]` | Compare revisions |
| `test [source]` | Verify specs (materialized or `--future`) |

## Review

| Command | Purpose |
|---|---|
| `discuss <source>` | Interactive TUI session against a file |
| `next <source>` | Show what the next runnable task would be |
| `list <source>` | List tasks (`--all` to include checked) |
| `log` | Show run history and traces |

## Maintenance

| Command | Purpose |
|---|---|
| `undo` | Semantic reversal of last task outcome |
| `revert <source>` | Revert revertable task commits |
| `reverify <source>` | Re-run verification on completed tasks |
| `repair <source>` | Run repair pass without full execution |
| `unlock <source>` | Release stuck file locks |
| `init` | Initialize `.rundown/` in current project |
| `with <harness>` | Configure worker harness preset |
| `config <action>` | Get/set/unset config keys (`--scope local|global`) |
| `workspace` | Manage linked workspace metadata |
| `worker-health` | Show worker health status |

## Global

| Flag | Purpose |
|---|---|
| `--config-dir <path>` | Explicit `.rundown/`, bypasses upward discovery |
| `--agents` | Print AGENTS.md guidance to stdout (root-level only) |
