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
| `--var <key=value>` (repeatable) | Inline template var |
| `--trace` | Enable JSONL trace writer |
| `--keep-artifacts` | Retain `.rundown/runs/<run-id>/` on success |
| `--print-prompt` | Print rendered prompt without running worker |
| `--dry-run` | Report what would run without spawning workers |
| `--show-agent-output` | Mirror worker stdout to console |
| `--ignore-cli-block` | Treat `cli:` blocks as plain tasks |
| `--cli-block-timeout <ms>` | Timeout for inline `cli:` blocks (milliseconds; `0` disables) |
| `--force-unlock` | Break stale file lock at startup |

## `materialize <source>`

Convenience wrapper for `run --all --revertable`. Same options as `run`. The CI agent-materialize workflow uses this command exclusively.

## `call <source>`

Run a full clean pass across all tasks with CLI block caching enabled. Internally equivalent to `run --all --clean --cache-cli-blocks`. Useful as the canonical "stateless full-document pass" entry point where `cli:` block results are cached for the duration of the pass. Inherits all `run`-style options.

## `do <seed-text> <markdown-file>`

Bootstraps a new Markdown task file from `<seed-text>` (via `make`'s research+plan pipeline) and then immediately executes the resulting tasks against that same file. Effectively a one-shot "describe what I want, get the work done" entry point. Inherits the run-style options (`--repair-attempts`, `--commit`, `--rounds`, `--clean`, `--reset-after`, `--revertable`, `--trace`, `--keep-artifacts`, …).

## `loop <source>`

Repeatedly executes full clean `call` passes (each pass = `run --all --clean --cache-cli-blocks`) with an optional cooldown between iterations. Useful when the source includes self-extending tasks (e.g. a planner-driven loop with `optional:` early exit) that need multiple passes to converge.

Loop-specific options (in addition to `run`-style options):

| Option | Effect |
|---|---|
| `--cooldown <seconds>` | Delay between iterations (default `5`) |
| `--iterations <n>` | Stop after N iterations (default: unlimited) |
| `--time-limit <seconds>` | Stop loop after total runtime budget elapses |
| `--continue-on-error` | Keep looping even after an iteration fails |

## `all <source>`

Implicit-all alias. Behaves like `run --all`. Provided for use inside seed scripts where it reads more naturally than `run --all`.

## Shared exit codes

[src/domain/exit-codes.ts](../../implementation/src/domain/exit-codes.ts) defines the canonical numeric codes:

- `0` — success
- non-zero — categorized failure (verification, execution, lock contention, config error, …)

The CLI translates application failures into these codes via [src/presentation/cli-command-actions.ts](../../implementation/src/presentation/cli-command-actions.ts).
