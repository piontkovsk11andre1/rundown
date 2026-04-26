# Execution commands

The commands that actually run task work.

## `run <source>`

The canonical entry point. Selects the next runnable unchecked task and runs the verify-repair loop.

Key options:

| Option | Effect |
|---|---|
| `--all` | Run every runnable task in document order; loop until done |
| `--rounds <n>` | Repeat the full pass `n` times sequentially |
| `--worker <pattern>` / `-- <argv>` | Override worker resolution |
| `--repair-attempts <n>` | Cap repair retries (default per-config) |
| `--no-repair` | Disable repair regardless of `--repair-attempts` |
| `--commit` | Git-commit each completed task |
| `--commit-mode per-task\|file-done` | Commit timing (default `per-task`) |
| `--commit-message <msg>` | Override commit message format |
| `--revertable` | Persist `extra.commitSha` for `revert` |
| `--clean` | Reset all checkboxes before run |
| `--reset-after` | Reset all checkboxes after success |
| `--sort <mode>` | `name-sort` / `none` / `old-first` / `new-first` |
| `--vars-file <file>` | Load template vars from JSON/YAML |
| `-V, --var <key=val>` (repeatable) | Inline template var |
| `--trace` | Enable JSONL trace writer |
| `--keep-artifacts` | Retain `.rundown/runs/<run-id>/` on success |
| `--print-prompt` | Print rendered prompt without running worker |
| `--dry-run` | Report what would run without spawning workers |
| `--show-agent-output` | Mirror worker stdout to console |
| `--ignore-cli-block` | Treat `cli:` blocks as plain tasks |
| `--cli-block-timeout-ms <n>` | Timeout for inline `cli:` blocks |
| `--force-unlock` | Break stale file lock at startup |

## `materialize <source>`

Convenience wrapper for `run --all --revertable`. Same options as `run`. The CI agent-materialize workflow uses this command exclusively.

## `call <source>`

Run a single named task by 1-based index or text match.

```
rundown call tasks.md --index 3
rundown call tasks.md --text "deploy staging"
```

## `do <task-text>`

Execute a one-off inline task without persisting to a file. The task body is taken from the argument; the runtime constructs an ephemeral source under `<config-dir>/runs/...` and runs the standard loop against it.

## `loop <source>`

Like `run --all`, but **repeats** until either the source is fully checked or an error occurs. Useful when the source includes self-extending tasks (e.g. a planner-driven loop with `optional:` early exit).

## `all <source>`

Implicit-all alias. Behaves like `run --all`. Provided for use inside seed scripts where it reads more naturally than `run --all`.

## Shared exit codes

[src/domain/exit-codes.ts](../../implementation/src/domain/exit-codes.ts) defines the canonical numeric codes:

- `0` — success
- non-zero — categorized failure (verification, execution, lock contention, config error, …)

The CLI translates application failures into these codes via [src/presentation/cli-command-actions.ts](../../implementation/src/presentation/cli-command-actions.ts).
