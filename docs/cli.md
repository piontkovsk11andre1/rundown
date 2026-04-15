# CLI

`rundown` and `rd` are both supported executable names. `rd` is a strict alias of `rundown` (same entrypoint, commands, flags, output, and exit codes). Examples below use `rundown` as the canonical form unless noted.

## Global option

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies (for example, `init` creates one locally).

Examples:

```bash
# Monorepo: run from a package, but keep shared rundown config at repo root
cd packages/api
rundown --config-dir ../../.rundown run TODO.md

# CI: use a workspace-mounted config outside the repo checkout
rundown --config-dir /workspace/rundown-config run docs/todos.md
```

## `--agents` output mode

Use `--agents` at the root to print deterministic, Markdown-safe AGENTS guidance to stdout and exit `0`.

Behavior:

- Root-only usage: `rundown --agents` and `rd --agents`.
- Non-interactive path: no worker startup, no live-help fallback, and no TUI dependency.
- Clean output contract: plain text only (no ANSI colors/spinners/status prefixes), newline-terminated.
- Deterministic precedence: when combined with `--help`, `--agents` takes precedence and emits AGENTS content.
- Subcommand misuse is rejected (for example, `rundown run tasks.md --agents`).

Redirection examples (POSIX shells):

```bash
# Inspect emitted AGENTS guidance in terminal
rundown --agents

# Create or overwrite AGENTS.md
rd --agents > AGENTS.md

# Append guidance to existing AGENTS.md
rd --agents >> AGENTS.md
```

Redirection examples (PowerShell):

```powershell
# Inspect emitted AGENTS guidance in terminal
rundown --agents

# Create or overwrite AGENTS.md
rd --agents > AGENTS.md

# Append guidance to existing AGENTS.md
rd --agents >> AGENTS.md
```

Cross-shell notes:

- `>` overwrites; `>>` appends.
- Re-running append commands adds another full copy of the guidance (no built-in dedupe).
- `rd` and `rundown` are alias-equivalent and emit byte-identical `--agents` output.

### `rundown`

Running `rundown` with no subcommand and no positional arguments starts an interactive live-help session when possible.

Behavior:

- On successful runtime startup, root `rundown` emits this canonical welcome line first (exact text): "Welcome to rundown. Start with `plan`, `explore`, `run`, or `help`."
- The canonical welcome is session-scoped: it appears exactly once per root invocation before any worker-generated help/discovery output.
- In an interactive terminal (`stdout` and `stderr` are TTY), rundown attempts to launch a TUI help session.
- The help session uses the configured `help` worker resolution path (or falls back through command/default worker config as configured).
- The prompt is template-backed and ordered as warmup then guidance (`agent.md` -> `help.md`), including CLI usage and repository context so you can ask follow-up questions immediately.
- `agent.md` resolves from the active config directory (`--config-dir` when provided, otherwise discovered `.rundown/`).
- If `agent.md` is missing, unreadable, or effectively empty, rundown uses the built-in default warmup template and continues.
- This no-arg warmup behavior applies only to root help startup and does not change deterministic worker conventions (`run`/`plan`/`research`/`reverify` use `opencode run`; `discuss` uses interactive `opencode`).
- If TTY is unavailable (for example CI/piped output) or no worker can be resolved, rundown falls back to static Commander help and exits `0`.
- Worker/config launch errors for this no-arg path also degrade to static help instead of failing hard.

Compatibility notes:

- `rundown --help` remains deterministic and non-interactive.
- `rundown <invalid-command>` keeps normal Commander error/help behavior.
- Explicit subcommands (`rundown run ...`, `rundown plan ...`, etc.) are unchanged.

Examples:

```bash
# Interactive terminal: opens live help TUI (when worker is configured)
rundown
rd

# Deterministic static help output
rundown --help
rd --help
```

## Main commands

### Terminal timestamps

Human-readable CLI output uses deterministic local-time ISO-8601 timestamps (with numeric UTC offset) where rundown emits command-level lifecycle lines.

- Timestamp format: bracketed local ISO-8601 with numeric offset (`[YYYY-MM-DDTHH:mm:ss.sss+/-HH:MM]`).
- Presentation points: `info`, `warn`, `error`, `success`, `progress`, `group-start`, and `group-end` terminal lines.
- Display timestamps are localized for operator readability; persisted artifact/global log timestamps (`startedAt`/`completedAt` and JSONL `ts`) remain UTC for machine-oriented interoperability.
- Nested/grouped output preserves existing grouping prefixes; timestamps are additive and appear after group markers.
- Task/detail listing payloads (`task` events) and raw worker transcript text (`text`/`stderr`) keep their existing shape.
- Text output is human-oriented and may evolve; for machine consumers, use `--json` on supported commands.

### `rundown start <description>`

See the command-focused reference: [cli-start.md](cli-start.md).

### `rundown migrate [action]`

See the command-focused reference: [cli-migrate.md](cli-migrate.md).

### `rundown design`

See the command-focused reference: [cli-design.md](cli-design.md).

### `rundown run <source>`

See the command-focused reference: [cli-run.md](cli-run.md).

### `rundown call <source>`

See the command-focused reference: [cli-call.md](cli-call.md).

### `rundown materialize <source>`

See the command-focused reference: [cli-materialize.md](cli-materialize.md).

### `rundown loop <source>`

See the command-focused reference: [cli-loop.md](cli-loop.md).

### `rundown discuss <source>`

See the command-focused reference: [cli-discuss.md](cli-discuss.md).

### `rundown reverify`

See the command-focused reference: [cli-reverify.md](cli-reverify.md).

### `rundown revert`

See the command-focused reference: [cli-revert.md](cli-revert.md).

### `rundown undo`

See the command-focused reference: [cli-undo.md](cli-undo.md).

### `rundown test [action]`

See the command-focused reference: [cli-test.md](cli-test.md).

### `rundown plan <markdown-file>`

See the command-focused reference: [cli-plan.md](cli-plan.md).

### `rundown explore <markdown-file>`

See the command-focused reference: [cli-explore.md](cli-explore.md).

### `rundown make <seed-text> <markdown-file>`

See the command-focused reference: [cli-make.md](cli-make.md).

### `rundown do <seed-text> <markdown-file>`

See the command-focused reference: [cli-do.md](cli-do.md).

### `rundown query <text>`

See the command-focused reference: [cli-query.md](cli-query.md).

### `rundown memory-view <source>`

See the command-focused reference: [cli-memory-view.md](cli-memory-view.md).

### `rundown memory-validate <source>`

See the command-focused reference: [cli-memory-validate.md](cli-memory-validate.md).

### `rundown memory-clean <source>`

See the command-focused reference: [cli-memory-clean.md](cli-memory-clean.md).

### `rundown worker-health`

See the command-focused reference: [cli-worker-health.md](cli-worker-health.md).

### `rundown unlock <source>`

See the command-focused reference: [cli-unlock.md](cli-unlock.md).

### `rundown workspace`

See the command-focused reference: [cli-workspace.md](cli-workspace.md).

### `rundown next <source>`

See the command-focused reference: [cli-next.md](cli-next.md).

### `rundown list <source>`

See the command-focused reference: [cli-list.md](cli-list.md).

### `rundown artifacts`

See the command-focused reference: [cli-artifacts.md](cli-artifacts.md).

### `rundown log`

See the command-focused reference: [cli-log.md](cli-log.md).

## Source file locking

`rundown` uses per-source lockfiles to prevent concurrent writes to the same Markdown file.

- Lock path: `<source-dir>/.rundown/<basename>.lock`
- Lock payload: JSON metadata with holder `pid`, command name, start time, and source path

Lock location strategy:

- Lockfiles remain source-relative even when `--config-dir` points elsewhere or config discovery resolves to a parent directory.
- `--config-dir` does not move lockfiles; it only controls configuration/template/vars/artifact/log roots.

Lock scope by command:

- `run`: acquires before task-selection reads and holds through the full task lifecycle, including `--all` loops, verification/repair, checkbox updates, and `--on-complete`/`--on-fail` hooks.
- `plan`: acquires before planning starts and holds for the full scan loop until planning finalization completes.
- `explore`: acquires phase locks in sequence (`research` lock first, then `plan` lock).
- `make`: acquires phase locks in sequence (`research` lock first, then `plan` lock) while running create -> research -> plan.
- `research`: acquires before reading the source and holds through worker invocation plus document replacement/guard checks.
- `revert`: acquires before git undo operations for the target source set and releases after undo processing finishes.
- `discuss`: acquires before task-selection reads and holds for the full discussion lifecycle, including worker invocation and finalization.
- `list`, `next`, and `reverify`: no exclusive source lock (read-only behavior).

Stale lock detection:

- If lockfile exists and holder PID is still running, lock acquisition fails fast with holder details.
- If lockfile exists but holder PID is no longer running, the lock is treated as stale and can be removed.

Stale lock recovery:

- `run`, `plan`, `research`, `make`, and `explore` support `--force-unlock` to remove stale lockfiles before normal lock acquisition. Live-process locks are never removed by this flag.
- `unlock` provides manual stale-lock cleanup for one source file.

`unlock` exit behavior:

- `0`: stale lock removed
- `1`: lock held by live process (no change)
- `3`: no lockfile found for source

## Global output log (JSONL)

`rundown` also defines a process-wide append-only JSONL stream at `<config-dir>/logs/output.jsonl`.

When `--trace` is enabled on `run`, `discuss`, `reverify`, or `plan`, each artifact trace event (including LLM/worker-derived stages such as `agent.signals`, `agent.thinking`, and `analysis.summary`) is also appended to `<config-dir>/logs/trace.jsonl` as a cumulative stream.

For `force:` retries in `run`, each retry attempt creates a separate artifact run with a distinct run identifier (`runId` in docs, serialized as `run_id` in trace records). Attempts are separate runs (N retries => N runs), not sub-attempts inside one run. The new attempt emits a `force.retry` event carrying `previous_run_id` and `previous_exit_code` so trace consumers can correlate attempts to the prior run.

Promtail note: configure this file as a scrape target to ingest a single cumulative CLI output stream across all runs.

First-iteration constraints: rundown does not implement built-in rotation or compression for this file, and it does not backfill older run output into this global stream. Manage retention with external log rotation or downstream pipeline policy.

Each line is one JSON object with these stable fields:

| Field | Type | Description |
|---|---|---|
| `ts` | `string` | Event timestamp in ISO-8601 UTC format. |
| `level` | `"info" \| "warn" \| "error"` | Severity level for the rendered event. |
| `stream` | `"stdout" \| "stderr"` | Logical stream classification for sink routing. |
| `kind` | `string` | Stable event kind label from rundown output semantics. |
| `message` | `string` | Plain-text message payload for the event. |
| `command` | `string` | Top-level CLI command name (for example `run`, `reverify`, `plan`). |
| `argv` | `string[]` | Full CLI argument vector for the invocation (excluding node runtime executable paths). |
| `cwd` | `string` | Process current working directory for the invocation. |
| `pid` | `number` | Process identifier for the CLI invocation. |
| `version` | `string` | Rundown CLI version string. |
| `session_id` | `string` | Invocation-scoped unique identifier used to correlate entries from one CLI session. |

### `rundown init`

See the command-focused reference: [cli-init.md](cli-init.md).

### `rundown with <harness>`

See the command-focused reference: [cli-with.md](cli-with.md).

### `rundown intro`

See the command-focused reference: [cli-intro.md](cli-intro.md).

### `rundown config`

See the command-focused reference: [cli-config.md](cli-config.md).

### `rundown research <markdown-file>`

See the command-focused reference: [cli-research.md](cli-research.md).

