# CLI: `run`

Scan a file, directory, or glob, select the next runnable task, execute it, verify it, optionally repair it, and mark it complete only after verification succeeds.

With `--all` (or the shorthand `all` command), process tasks sequentially until all are complete or a failure occurs.

Agent stdout/stderr is hidden by default. Use `--show-agent-output` to display worker output for `execute`, `verify`, and `repair` stages while keeping `discuss` worker output silent.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown run <source> [options] -- <command>
rundown run <source> [options] --worker <pattern>
rd run <source> [options]
```

Arguments:

- `<source>`: Markdown file, directory, or glob to process.

Options:

- `--mode <mode>`: Runner execution mode: `wait`, `tui`, `detached` (default: `wait`).
- `--sort <sort>`: File sort mode: `name-sort`, `none`, `old-first`, `new-first`.
- `--verify` / `--no-verify`: Enable or disable verification after task execution (verification is enabled by default).
- `--only-verify`: Skip execution and run verification directly.
- `--force-execute`: Force execute phase even for verify-only task text.
- `--force-attempts <n>`: Default outer retry attempts for `force:`-prefixed tasks.
- `--repair-attempts <n>`: Max repair attempts on verification failure.
- `--resolve-repair-attempts <n>`: Max resolve-informed repair attempts after diagnosis.
- `--no-repair`: Disable repair even when repair attempts are set.
- `--dry-run`: Show what would be executed without running it.
- `--print-prompt`: Print the rendered prompt and exit.
- `--keep-artifacts`: Preserve runtime prompts, logs, and metadata under `<config-dir>/runs`.
- `--trace`: Enable structured JSONL trace output at `<config-dir>/runs/<id>/trace.jsonl`.
- `--all`: Process runnable tasks sequentially until completion or first failure.
- `--trace-stats`: Insert inline task trace statistics under completed TODOs in source Markdown.
- `--trace-only`: Skip task execution and run only trace enrichment on the latest completed artifact run.
- `--vars-file [path]`: Load extra template variables from a JSON file (default: `<config-dir>/vars.json`).
- `--var <key=value>`: Inject a template variable into prompts (repeatable).
- `--commit`: Auto-commit checked task file after successful completion.
- `--commit-message <template>`: Commit message template (supports `{{task}}` and `{{file}}`).
- `--commit-mode <per-task|file-done>`: Commit timing for `--commit` (default: `per-task`). `file-done` is for effective run-all (`--all`, `all`, `--redo`, `--clean`).
- `--revertable`: Shorthand for `--commit --keep-artifacts`.
- `--on-complete <command>`: Run a shell command after successful task completion.
- `--on-fail <command>`: Run a shell command when a task fails (execution or verification failure).
- `--show-agent-output`: Show worker-derived `text`/`stderr` transcript output for supported stages.
- `-v, --verbose`: Show detailed per-phase run diagnostics (within grouped output).
- `-q, --quiet`: Suppress info-level output (info, success, progress, grouped status).
- `--redo`: Re-run previously completed tasks before continuing normal task selection.
- `--reset-after`: Reset completion state after processing so tasks can be run again.
- `--clean`: Shorthand for `--redo --reset-after`.
- `--rounds <n>`: Repeat clean cycles `N` times (default: `1`).
- `--force-unlock`: Break stale source lockfiles before acquiring run locks.
- `--worker <pattern>`: Optional worker pattern override (alternative to `-- <command>`).
- `--ignore-cli-block`: Disable execution of `cli` fenced blocks during prompt expansion.
- `--cache-cli-blocks`: Cache `cli` fenced block command output for the duration of the run.
- `--cli-block-timeout <ms>`: Timeout in milliseconds for executing `cli` fenced blocks (`0` disables timeout).

Examples:

```bash
rundown run roadmap.md
rundown run docs/
rundown run "notes/**/*.md"
rundown run roadmap.md --all
rundown run roadmap.md --redo
rundown run roadmap.md --reset-after
rundown run roadmap.md --clean
rundown all roadmap.md
rundown run tasks.md --show-agent-output
rundown run docs/ --commit
rundown run docs/ --all --commit --commit-mode file-done
```

PowerShell-safe form:

```powershell
rundown run docs/
rundown run docs/ --all
rundown all docs/
rundown run docs/ --show-agent-output
```

Agent output notes (`run --show-agent-output`):

- Default behavior (option omitted): suppress worker-derived `text` and `stderr` transcript output across stages.
- With `--show-agent-output`: show worker-derived `text` and `stderr` transcript output for `execute`, `verify`, and `repair` stages (including inline `cli:` task stdout/stderr).
- `discuss` remains silent for worker transcript output even when `--show-agent-output` is set.
- Still visible: rundown lifecycle/status messages (`info`, `warn`, `error`, `success`, `task`).
- Still visible: hook output from `--on-complete` and `--on-fail` (intentionally out of scope for this option).
- Artifacts/traces still capture output for audit/debug; terminal suppression does not disable persistence.
