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

Scaffold a prediction-oriented project workspace.

By default, `start` creates a design-first project structure and prepares migration/spec workflows:

- `design/current/`
- `design/current/Target.md`
- `AGENTS.md`
- `migrations/`
- `migrations/0001-initialize.md`
- `specs/`
- `.rundown/`

Use `--design-dir`, `--specs-dir`, and `--migrations-dir` to override these workspace directories at bootstrap time. Rundown persists the resolved mapping in `.rundown/config.json` and reuses it across prediction flows (`migrate`, `design`, `test`, and related commands).

Use `--design-placement`, `--specs-placement`, and `--migrations-placement` to choose the placement root for each bucket:

- `sourcedir` (default): resolve bucket path under the effective workspace/source directory.
- `workdir`: resolve bucket path under the invocation/working directory.

Placement defaults are persisted to `.rundown/config.json` under `workspace.placement` and apply to path-sensitive prediction flows.

Placement terminology:

- `sourcedir`: effective workspace/source directory used by command resolution.
- `workdir`: invocation directory where the command was launched.

In non-linked mode, `sourcedir` and `workdir` are the same path. In linked mode, they can differ.

Linked-workspace behavior:

- When `start` is invoked from a linked directory, rundown writes link metadata in both places:
  - target workspace `.rundown/workspace.link` points back to the source workspace (legacy single-path format for compatibility)
  - source workspace `.rundown/workspace.link` is updated in multi-record schema so one source can link to multiple targets
- Existing single-link repositories remain compatible; legacy single-path `workspace.link` still resolves.

Directory override rules:

- Paths must be relative to the project root.
- Paths must resolve inside the project root (for example, `../outside` is rejected).
- Workspace targets must be distinct and non-nested (no duplicates or parent/child overlaps).
- Invalid values fail fast with actionable CLI errors that name the offending option.

Compatibility note: legacy `docs/current/Design.md` and root `Design.md` are still read as fallbacks when `design/current/` is not available.

Synopsis:

```bash
rundown start "<description>" [--dir <path>] [--design-dir <path>] [--specs-dir <path>] [--migrations-dir <path>] -- <command>
rundown start "<description>" [--dir <path>] [--design-dir <path>] [--specs-dir <path>] [--migrations-dir <path>] --worker <pattern>
```

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Target directory for scaffold output. | current working directory |
| `--design-dir <path>` | Design workspace directory name/path for start scaffold. | `design` |
| `--specs-dir <path>` | Specs workspace directory name/path for start scaffold. | `specs` |
| `--migrations-dir <path>` | Migrations workspace directory name/path for start scaffold. | `migrations` |
| `--design-placement <mode>` | Design placement root: `sourcedir` or `workdir`. | `sourcedir` |
| `--specs-placement <mode>` | Specs placement root: `sourcedir` or `workdir`. | `sourcedir` |
| `--migrations-placement <mode>` | Migrations placement root: `sourcedir` or `workdir`. | `sourcedir` |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Examples:

```bash
rundown start "Ship auth flow" -- opencode run
rundown start "Ship auth flow" --design-dir design --specs-dir specs --migrations-dir migrations -- opencode run
rundown start "Ship auth flow" --design-placement sourcedir --specs-placement workdir --migrations-placement sourcedir -- opencode run
rundown start "Ship auth flow" --dir ./predict-auth --design-dir docs --specs-dir checks --migrations-dir changes -- opencode run
```

### `rundown migrate [action]`

Generate and manage prediction migrations.

Without an action, `migrate` generates the next migration proposal based on design and migration context.

Design context resolution is revision-aware: it prefers `design/current/**`, includes revision/archive directories (`design/rev.*/**`) as context sources, and falls back to legacy `docs/current/**`, `docs/rev.*/**`, and root `Design.md` for older projects.

Synopsis:

```bash
rundown migrate [action] [options] -- <command>
rundown migrate [action] [options] --worker <pattern>
```

Actions:

- omitted: generate next migration
- `up`: execute migration tasks (`run-all` style)
- `down [n]`: alias of `rundown undo [--last n]`
- `snapshot`: generate `NNNN--snapshot.md`
- `backlog`: generate `NNNN--backlog.md`
- `context`: (re)generate `NNNN--context.md`
- `review`: generate `NNNN--review.md`
- `user-experience`: generate `NNNN--user-experience.md`
- `user-session`: interactive migration discussion session

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on. | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. Required when link metadata is ambiguous. | unset |
| `--confirm` | Print generated content and ask before each write. Non-TTY uses default yes. | off |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Workspace selection notes (`migrate`, `design release`, `design diff`):

- By default, path-sensitive commands resolve workspace from `.rundown/workspace.link`.
- If link metadata has multiple records and no default, command resolution is ambiguous and the command fails with candidate paths.
- Use `--workspace <dir>` to select the effective workspace explicitly (relative to invocation directory).

Prediction workspace placement notes (`migrate`, `design`, `test`, `plan`, `research`, `run` prompt context):

- Bucket paths are resolved from two config layers: `workspace.directories.<bucket>` and `workspace.placement.<bucket>`.
- Effective bucket path rule: selected root (`sourcedir` or `workdir`) + configured relative bucket directory.
- Default placement is `sourcedir` for `design`, `specs`, and `migrations` when placement config is omitted.
- Mixed placement is valid (for example, `design` on `sourcedir`, `specs` on `workdir`, `migrations` on `sourcedir`).
- In linked mode, `sourcedir` maps to the resolved linked workspace, while `workdir` stays at the invocation directory.
- If any two buckets resolve to the same absolute path (including across different roots), command resolution fails with a placement conflict error.

Mixed-placement example:

```json
{
  "workspace": {
    "directories": {
      "design": "design",
      "specs": "checks/specs",
      "migrations": "migrations"
    },
    "placement": {
      "design": "sourcedir",
      "specs": "workdir",
      "migrations": "sourcedir"
    }
  }
}
```

Linked workspace example (resolved roots):

- invocation (`workdir`): `/Users/alex/client-a`
- resolved workspace (`sourcedir`): `/Users/alex/platform-core`
- effective paths:
  - design -> `/Users/alex/platform-core/design`
  - specs -> `/Users/alex/client-a/checks/specs`
  - migrations -> `/Users/alex/platform-core/migrations`

### `rundown design`

Manage design-doc revision lifecycle separately from migration execution.

Use `design` commands for revision snapshots and revision diffs; use `migrate` commands for migration proposal generation, execution, and satellites.

#### `rundown design release`

Release `design/current/` into the next immutable `design/rev.N/` snapshot.

No-change behavior is preserved: when `design/current/` is byte-for-byte unchanged from the latest revision directory, no new `design/rev.N/` directory is created and the command reports a no-op.

Synopsis:

```bash
rundown design release [options]
```

Compatibility note:

- `rundown design release` is the canonical snapshot command.
- `rundown docs release` remains available as a deprecated alias and prints guidance to move to `design release`.
- `rundown docs publish` remains available as a deprecated alias and prints guidance to move to `design release`.
- `rundown docs save` is removed and fails with an actionable message that points to `design release`.

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on (used to resolve project root). | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. | unset |
| `--label <text>` | Optional label stored in revision sidecar metadata. | unset |

#### `rundown design diff [target]`

Show revision diff context using either shorthand target or explicit selectors.

Revision contract:

- `rev.0` is the explicit baseline initial state when it exists.
- For target `rev.N`, compare from the nearest discovered lower revision when available.
- If no discovered lower revision exists (including repositories where `rev.1` is the first revision), treat diff as `nothing -> rev.N`.

Shorthand targets:

- omitted / `current`: diff summary output
- `preview`: diff summary + source reference listing

Explicit selector form:

- `--from <rev|current> --to <rev|current>`
- In this build, `--to` must be `current` (for deterministic compare-to-draft behavior)
- You cannot combine shorthand `[target]` with explicit selectors

Synopsis:

```bash
rundown design diff [target] [options]
```

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on (used to resolve project root). | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. | unset |
| `--from <rev|current>` | Explicit source selector (use with `--to`). | unset |
| `--to <rev|current>` | Explicit destination selector (use with `--from`; must be `current` in this build). | unset |

#### `rundown docs` (deprecated alias)

`rundown docs` remains available as a transition alias for one migration window.

- `rundown docs release` -> deprecated alias for `rundown design release`
- `rundown docs diff` -> deprecated alias for `rundown design diff`
- `rundown docs publish` -> deprecated alias for `rundown design release`
- `rundown docs save` -> removed alias with actionable migration guidance

Migration file naming:

- step migration: `0007-implement-feature.md`
- satellite artifact: `0007--snapshot.md`

Single dash identifies a migration step; double dash identifies a satellite artifact type for the same migration position.

### `rundown run <source>`

Scan a file, directory, or glob, select the next runnable task, execute it, verify it, optionally repair it, and mark it complete only after verification succeeds.

With `--all` (or the shorthand `all` command), process tasks sequentially until all are complete or a failure occurs.

Agent stdout/stderr is hidden by default. Use `--show-agent-output` to display worker output for `execute`, `verify`, and `plan` stages while keeping `discuss` worker output silent.

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
- With `--show-agent-output`: show worker-derived `text` and `stderr` transcript output for `execute`, `verify`, and `plan` stages (including inline `cli:` task stdout/stderr).
- `discuss` remains silent for worker transcript output even when `--show-agent-output` is set.
- Still visible: rundown lifecycle/status messages (`info`, `warn`, `error`, `success`, `task`).
- Still visible: hook output from `--on-complete` and `--on-fail` (intentionally out of scope for this option).
- Artifacts/traces still capture output for audit/debug; terminal suppression does not disable persistence.

### `rundown call <source>`

Run a full clean pass across all tasks in one command.

`call` is a convenience wrapper over `run` that forces these options per invocation:

- `--all`
- `--clean`
- `--cache-cli-blocks`

This makes `call` the preferred command when you want an end-to-end clean execution pass without repeating flags.

Synopsis:

```bash
rundown call <source> [options] -- <command>
rundown call <source> [options] --worker <pattern>
```

Behavior notes:

- Accepts the same run-like options as `run` (verification/repair, commit/hook, output, vars, lock, and worker options).
- Explicit user-supplied values for `--all`, `--clean`, and `--cache-cli-blocks` are ignored because `call` enforces them.

Examples:

```bash
# Full clean pass across one task file
rundown call roadmap.md

# Full clean pass across a directory source
rundown call docs/
```

### `rundown materialize <source>`

Run a full task pass with revertable defaults.

`materialize` is a convenience wrapper over `run` that forces these options per invocation:

- `--all`
- `--revertable` (equivalent to `--commit --keep-artifacts`)

Use `materialize` when you want to execute all tasks while keeping artifact state and commit metadata aligned for reversal flows.

Synopsis:

```bash
rundown materialize <source> [options] -- <command>
rundown materialize <source> [options] --worker <pattern>
```

Arguments:

- `<source>`: file, directory, or glob to scan for Markdown tasks.

Options:

- `materialize` accepts the same run-like options as `run` (`--verify`, `--repair-attempts`, `--sort`, `--trace`, `--vars-file`, `--worker`, and related flags).
- Explicit user-supplied values for `--all` and `--revertable` are ignored because `materialize` enforces them.

Examples:

```bash
# Execute all tasks with revertable behavior
rundown materialize roadmap.md

# Materialize a directory source
rundown materialize docs/

# Materialize with explicit worker pattern
rundown materialize roadmap.md --worker "opencode run $file"
```

### `rundown loop <source>`

Run repeated `call`-style full clean passes against a source, with a cooldown between iterations.

`loop` composes `call` semantics per iteration (`--all --clean --cache-cli-blocks`) and then waits before starting the next pass.

Synopsis:

```bash
rundown loop <source> [options] -- <command>
rundown loop <source> [options] --worker <pattern>
```

Options:

| Option | Description | Default |
|---|---|---|
| `--cooldown <seconds>` | Delay between iterations. `0` starts the next pass immediately. | `60` |
| `--iterations <n>` | Stop after `n` iterations. If omitted, loop runs until interrupted. | unlimited |
| `--continue-on-error` | Continue looping after a failed iteration instead of exiting immediately. | off |

`loop` also accepts all run-like options (`--verify`, `--repair-attempts`, `--commit`, `--worker`, `--trace`, etc.), which are forwarded to each inner `call` iteration.

Behavior notes:

- Infinite mode (default): if `--iterations` is omitted, `loop` runs until interrupted.
- Bounded mode: `--iterations <n>` runs exactly `n` iterations, then exits.
- Failure handling default: stop on first non-zero iteration exit code.
- Failure handling override: with `--continue-on-error`, failed iterations are logged and the loop continues after cooldown.
- Interrupt handling: `Ctrl+C` during cooldown exits cleanly without waiting for the full cooldown.
- Mode support: `loop` supports `--mode wait` only (interactive modes are rejected).

Exit codes:

- `0`: bounded iterations completed, or graceful interrupt (`SIGINT`) during loop/cooldown.
- `1`: iteration execution error (when `--continue-on-error` is not set).
- `2`: iteration validation failure (when `--continue-on-error` is not set).

Examples:

```bash
# Continuous processing with 10-second cooldown
rundown loop roadmap.md --cooldown 10

# Exactly 3 iterations with 5-second cooldown
rundown loop docs/ --cooldown 5 --iterations 3

# Keep looping even if an iteration fails
rundown loop "tasks/**/*.md" --cooldown 30 --continue-on-error
```

### `rundown discuss <source>`

Select the next unchecked task and start a discussion session for task refinement before execution.

Synopsis:

```bash
rundown discuss <source> [options] -- <command>
rundown discuss <source> [options] --worker <pattern>
```

`discuss` uses the same source resolution and task-selection logic as `run`, but opens a discussion-oriented worker session (default `--mode tui`) instead of executing the task implementation flow.

`--worker` is optional when rundown can resolve a worker for `discuss` from `.rundown/config.json`.

During this session, the agent may edit the Markdown source task text to improve scope and clarity (for example rewriting task wording, splitting tasks, or adding sub-items). `discuss` does not mutate checkbox completion state.

Options:

| Option | Description | Default |
|---|---|---|
| `--mode <tui|wait>` | Discussion worker mode. `tui` opens an interactive terminal UI; `wait` runs non-interactively. | `tui` |
| `--sort <name-sort|none|old-first|new-first>` | Source ordering strategy before task selection. | `name-sort` |
| `--dry-run` | Resolve task + render discuss prompt, print planned execution, and exit `0` without running worker. | off |
| `--print-prompt` | Print rendered discuss prompt and exit `0` without running worker. | off |
| `--keep-artifacts` | Keep discuss run artifacts under `.rundown/runs/` even on success. | off |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--show-agent-output` | Show discussion worker stdout/stderr transcript output during the discuss session (hidden by default). | off |
| `--force-unlock` | Remove stale source lockfile before acquiring discuss lock. Active locks held by live processes are not removed. | off |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Examples:

```bash
rundown discuss roadmap.md
rundown discuss docs/
rundown discuss tasks.md --mode wait
rundown discuss roadmap.md --print-prompt
rundown discuss roadmap.md --dry-run
```

### `rundown reverify`

Re-run verification for a previously completed task from saved run artifacts, without selecting a new unchecked task and without mutating Markdown checkboxes.

`reverify` intentionally does not acquire the per-source Markdown lock because it never writes task source files; it only reads source content to resolve historical task context.

By default, `reverify` targets the latest completed task in the current repository (`--run latest`).

Use this when you want a deterministic confidence check against an exact historical task context (for example, before a release or push) without advancing task selection.

`--worker` is optional when rundown can resolve a worker for `reverify` from `.rundown/config.json`.

Options:

| Option | Description |
|---|---|
| `--run <id|latest>` | Choose the artifact run to inspect for the completed task to re-verify. Default: `latest`. |
| `--last <n>` | Re-verify the last `n` completed runs. Default processing order is newest first. |
| `--all` | Re-verify all completed runs. Default processing order is newest first. |
| `--oldest-first` | Process selected runs in oldest-first order (applies to `--all` and `--last <n>`). |
| `--repair-attempts <n>` | Retry repair up to `n` times when verification fails. |
| `--no-repair` | Disable repair attempts and fail immediately on verification failure. |
| `--worker <pattern>` | Worker pattern to execute verify/repair phases (preferred on PowerShell). |
| `--print-prompt` | Print the rendered verify prompt and exit `0` without running the worker. |
| `--dry-run` | Resolve the target task, render the verify prompt, print planned execution, and exit `0`. |
| `--keep-artifacts` | Keep the reverify run folder under `.rundown/runs/`. |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). Default: `30000`. |

Note: `--print-prompt` is only supported for single-run reverify. Combining it with `--all` or `--last` returns exit code `1`.

Examples:

```bash
rundown reverify
rundown reverify --all
rundown reverify --last 3
rundown reverify --last 3 --oldest-first
rundown reverify --run latest
rundown reverify --run run-20260319T222645632Z-04e84d73 --repair-attempts 2
rundown reverify --run latest --no-repair
rundown reverify --run run-20260319T222645632Z-04e84d73 --no-repair
rundown reverify --print-prompt
rundown reverify --dry-run
```

### `rundown revert`

Undo previously completed tasks by reverting the git commit recorded in saved run artifacts.

By default, `revert` targets the latest completed+committed run in the current repository (`--run latest`) and uses `--method revert`.

Revertable run requirements:

- The original run status is `completed`.
- The original run used `--commit` (or `--revertable`).
- The original run used `--keep-artifacts` (or `--revertable`) so `run.json` still exists.
- The original run metadata includes `extra.commitSha`.

Commit timing affects revert granularity:

- `--commit-mode per-task` (default) records one commit per successful task, so revert can target task-level completions.
- `--commit-mode file-done` (effective run-all only) records one final commit for the completed run, so revert targets that run-level completion commit rather than each intermediate task.

Options:

| Option | Description | Default |
|---|---|---|
| `--run <id|latest>` | Target a specific run ID or `latest`. | `latest` |
| `--last <n>` | Revert the last `n` completed+committed runs (newest first for `revert`). | unset |
| `--all` | Revert all completed+committed runs. | off |
| `--method <revert|reset>` | Git undo strategy. `revert` creates inverse commits; `reset` rewinds history. | `revert` |
| `--dry-run` | Print what would be reverted and exit `0` without changing git state. | off |
| `--force` | Bypass clean-worktree and reset contiguous-HEAD checks. | off |
| `--keep-artifacts` | Keep artifacts from the `revert` command run. | off |

Target selection validation:

- `--all` and `--last <n>` cannot be combined.
- `--all` or `--last <n>` cannot be combined with `--run <specific-id>`.

Git method behavior:

- `--method revert` (safe default): reverts each target commit with `git revert <sha> --no-edit`.
- `--method reset`: only allowed when target commits are contiguous at `HEAD`; runs `git reset --hard <oldest-sha>~1`.
- Reset-generated revert runs can be restored later with `rundown revert --run <revert-run-id> --method reset`; this uses the saved `extra.preResetRef`.

Operational notes:

- Requires a clean working tree before running git undo operations.
- Acquires the same per-source Markdown lock used by `run`/`plan`; if another rundown process holds the lock, `revert` fails fast with holder details.
- This lock prevents concurrent `run` + `revert` on the same source file, avoiding task-line drift and unintended checkbox/source mutations from overlapping operations.
- Markdown checkboxes are restored by git history changes; no direct checkbox mutation is performed.
- Multi-run `revert` processes runs newest-first to reduce conflicts.
- Reverting a reset-generated revert run is supported one at a time and requires `--method reset`.
- `--force` skips clean-worktree validation and contiguous-HEAD validation for `--method reset`; use only when you understand the history impact.

Examples:

```bash
rundown revert
rundown revert --run latest
rundown revert --run run-20260319T222645632Z-04e84d73
rundown revert --last 3 --method revert
rundown revert --all --dry-run
rundown revert --last 2 --method reset
```

### `rundown undo`

Undo completed task runs using AI-generated reversal actions from execution artifacts.

Unlike `revert`, `undo` is semantic (artifact/context driven) rather than commit-level git history reversal.

Synopsis:

```bash
rundown undo [options] -- <command>
rundown undo [options] --worker <pattern>
```

Options:

| Option | Description | Default |
|---|---|---|
| `--run <id|latest>` | Target artifact run id or `latest`. | `latest` |
| `--last <n>` | Undo the last `n` completed runs. | `1` |
| `--force` | Bypass clean-worktree safety checks. | off |
| `--dry-run` | Show what would be undone without changing files. | off |
| `--keep-artifacts` | Preserve undo run artifacts under `<config-dir>/runs/`. | off |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

### `rundown test [action]`

Verify assertion specs in either materialized or prediction mode.

By default, `test` validates assertions against the materialized workspace and explicitly excludes prediction inputs (`design/`, `specs/`, `migrations/`) from test context.

When `--future` is set, `test` switches to prediction mode and validates assertions using design + migration context only.

Synopsis:

```bash
rundown test [action] [options] -- <command>
rundown test [action] [options] --worker <pattern>
```

Actions:

- omitted: verify all specs in the specs directory
- `new <assertion>`: create a new assertion spec file

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Specs directory. | `./specs` |
| `--future [n]` | Prediction mode. Without `n`, uses latest prediction (`latest snapshot + migrations`). With `n`, uses targeted prediction (`previous snapshot + migrations up to n`). | off |
| `--run` | For `test new`, create then immediately verify the new spec. | off |
| `--mode <tui|wait>` | For `test new`, choose interactive or non-interactive assertion authoring mode. | `wait` |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Template resolution:

- Materialized mode (`test` without `--future`): `.rundown/test-materialized.md` -> `.rundown/test-verify.md` -> built-in default
- Prediction mode (`test --future`): `.rundown/test-future.md` -> `.rundown/test-verify.md` -> built-in default

Harness/environment hints:

- `RUNDOWN_TEST_MODE` = `materialized` or `future`
- `RUNDOWN_TEST_FUTURE_TARGET` = migration target when `--future` is used
- `RUNDOWN_TEST_INCLUDED_DIRECTORIES` = JSON array of included directories
- `RUNDOWN_TEST_EXCLUDED_DIRECTORIES` = JSON array of excluded directories

### `rundown plan <markdown-file>`

Run document-level TODO synthesis on a single Markdown document using the planner template.

For thin specs, run `research` first so `plan` has richer context:

```bash
rundown research docs/spec.md
rundown plan docs/spec.md --scan-count 3
```

`plan` treats the full document as intent input. It creates actionable TODOs when none exist, then runs clean-session coverage scans that append only missing TODO items until convergence or the scan cap is reached.

When `--deep <n>` is set, `plan` then runs `n` additional nested passes after top-level scan convergence. Each deep pass targets current leaf TODO items (parents with no checkbox children) and asks the planner for child `- [ ]` items only.

Input rules:

- Exactly one file path is required.
- File extension must be `.md` or `.markdown`.
- Legacy task selection flags (`--at`, `--sort`) are rejected for `plan`.

Options:

| Option | Description | Default |
|---|---|---|
| `--scan-count <n>` | Maximum clean-session scan iterations. Must be a safe positive integer. | `3` |
| `--max-items <n>` | Maximum total TODO items allowed in the document after each scan merge. Planning stops once this cap is reached. Must be a safe non-negative integer. | unset |
| `--deep <n>` | Additional nested planning passes after top-level scans. Must be a safe non-negative integer (`0` disables deep passes). | `0` |
| `--mode <mode>` | Planner execution mode. Currently only `wait` is supported. | `wait` |
| `--force-unlock` | Remove stale source lockfile before acquiring the planner lock. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render plan prompt + execution intent and exit without running the worker. | off |
| `--print-prompt` | Print the rendered planner prompt and exit `0` without running the worker. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `.rundown/runs/` even on success. | off |
| `--show-agent-output` | Show planner worker stdout/stderr during execution (hidden by default). | off |
| `--no-show-agent-output` | Explicitly hide planner worker stdout/stderr during execution. Useful to override prior toggles. | on (effective default) |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror them to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Worker resolution:

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `plan` resolves the worker from `.rundown/config.json` using the standard resolution cascade.
- For OpenCode workers, continuation/resume session arguments are rejected so each scan runs in a clean session.

Scan loop and convergence semantics:

- Scans run from `1..scan-count` and always read the latest on-disk document before each pass.
- Each scan may only add TODO lines; edits/deletes/reorders of existing TODO text are rejected.
- Converges early when either:
  - worker output is empty, or
  - worker output contains no valid new TODO additions after normalization/idempotency checks.
- If no convergence signal occurs before the limit, planning stops at the configured scan cap.

Deep pass semantics (`--deep`):

- `--deep 0` (default): behavior is unchanged; only top-level scan coverage runs.
- Deep passes run after top-level scans, from `1..deep`.
- Before each deep pass, `plan` re-reads and re-parses the latest on-disk document.
- Each deep pass runs clean worker sessions per parent task and only inserts child TODO lines beneath that parent.
- Deep planning converges early when a pass has no candidate leaf tasks or when no child TODO lines are added.
- `--print-prompt` and `--dry-run` include deep-pass behavior preview when `--deep > 0`.

Artifacts and audit expectations:

- Scan phases are recorded with deterministic labels (`plan-scan-01`, `plan-scan-02`, ...).
- Run metadata includes convergence fields (`planConvergenceOutcome`, `planConverged`, `planScanCapReached`, `planEmergencyCapReached`, plus scan counts).
- Failed planning runs keep artifacts automatically.
- Successful runs are pruned by default unless `--keep-artifacts` is set.

Examples:

```bash
# Basic plan run
rundown plan roadmap.md --scan-count 3

# No TODOs yet: bootstrap actionable TODOs, then converge
rundown plan docs/spec.md --scan-count 3

# Existing TODOs: append missing implementation items only
rundown plan docs/migration.md --scan-count 2

# Add one nested layer of child TODOs after top-level scans
rundown plan docs/spec.md --scan-count 3 --deep 1

# Add two nested layers (children, then grandchildren)
rundown plan docs/spec.md --scan-count 3 --deep 2

# PowerShell-safe worker form
rundown plan docs/spec.md --scan-count 2

# PowerShell-safe deep planning
rundown plan docs/spec.md --scan-count 2 --deep 2
```

### `rundown explore <markdown-file>`

Run `research` and then `plan` on the same existing Markdown document.

`explore` is a convenience alias for the common enrichment flow on docs that already exist:

1. `rundown research <source>` enriches context and structure,
2. `rundown plan <source>` synthesizes actionable TODO items.

Synopsis:

```bash
rundown explore <markdown-file> [options] -- <command>
rundown explore <markdown-file> [options] --worker <pattern>
```

Usage example:

```bash
rundown explore docs/spec.md
```

Execution is sequential and fail-fast:

- `research` runs first.
- If `research` exits non-zero, `plan` is skipped.
- If both phases succeed, `explore` exits `0`.
- If either phase fails, `explore` returns the failing phase exit code.

Input rules:

- Exactly one file path is required.
- File extension must be `.md` or `.markdown`.
- Directories and globs are rejected.

Options:

| Option | Description | Default |
|---|---|---|
| `--mode <mode>` | Shared execution mode forwarded to both phases (`research` + `plan`). Use `wait` for compatibility with `plan`. | `wait` |
| `--scan-count <n>` | Planner-only scan cap forwarded to `plan`. Must be a safe positive integer. | `3` |
| `--deep <n>` | Planner-only nested pass count forwarded to `plan`. Must be a safe non-negative integer. | `0` |
| `--max-items <n>` | Planner-only item cap forwarded to `plan`. | unset |
| `--force-unlock` | Remove stale source lockfiles before each phase lock acquisition. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render phase prompts + execution intent and exit without running workers. | off |
| `--print-prompt` | Print rendered phase prompts and exit `0` without running workers. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `.rundown/runs/` even on success. | off |
| `--show-agent-output` | Show worker stdout/stderr during phase execution (hidden by default). | off |
| `-v, --verbose` | Show detailed per-task run diagnostics within grouped output for both phases. | off |
| `-q, --quiet` | Suppress info-level output (info, success, progress, grouped status) across both phases. | off |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Worker resolution:

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `explore` resolves worker input using the same command resolution behavior as `research` and `plan`.

Examples:

```bash
# One-step enrichment for an existing document: research -> plan
rundown explore docs/spec.md

# Include nested TODO generation in the plan phase
rundown explore docs/spec.md --scan-count 3 --deep 1

# PowerShell-safe worker form
rundown explore docs/spec.md
```

### `rundown make <seed-text> <markdown-file>`

Create a new Markdown file from seed text, then run `research` followed by `plan` on that same file.

Synopsis:

```bash
rundown make "<seed-text>" "<markdown-file>" [options] -- <command>
rundown make "<seed-text>" "<markdown-file>" [options] --worker <pattern>
```

`make` is a composition command for the authoring bootstrap flow:

1. create target Markdown file,
2. write `seed-text` as the initial file body,
3. run `research` on that file,
4. run `plan` on that file.

Execution is sequential and fail-fast:

- If file creation fails, `research` and `plan` do not run.
- If `research` fails, `plan` does not run.
- If `plan` fails, `make` exits non-zero and preserves generated artifacts per normal command behavior.

Input rules:

- Exactly two positional arguments are required: `<seed-text>` and `<markdown-file>`.
- Target extension must be `.md` or `.markdown`.
- Target must be a file path (directories are rejected).
- Existing files are not overwritten; `make` fails on collisions.
- Missing parent directories are treated as an error.

Options:

| Option | Description | Default |
|---|---|---|
| `--mode <mode>` | Make execution mode. Only `wait` is supported for deterministic non-interactive chaining. | `wait` |
| `--scan-count <n>` | Maximum clean-session scan iterations for the `plan` phase. Must be a safe positive integer. | `3` |
| `--force-unlock` | Remove stale source lockfiles before each phase lock acquisition. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render phase prompts + execution intent and exit without running workers. | off |
| `--print-prompt` | Print rendered phase prompts and exit `0` without running workers. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `.rundown/runs/` even on success. | off |
| `--show-agent-output` | Show worker stdout/stderr during phase execution (hidden by default). | off |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Worker resolution:

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `make` resolves worker input using the same command resolution behavior as `research` and `plan`.

Examples:

```bash
# One-step authoring bootstrap: create -> research -> plan
rundown make "please do something" "8. Do something.md"

# Use .markdown extension
rundown make "Draft migration plan" "docs/migration.markdown"

# Preview prompts without running workers
rundown make "Release prep" "docs/release-prep.md" --print-prompt
```

### `rundown do <seed-text> <markdown-file>`

Create a new Markdown task file from seed text (`make` workflow), then execute all tasks from that same file (`run --all`).

`do` is a convenience composition command for end-to-end bootstrap + execution:

1. create target file and write seed text,
2. run `research`,
3. run `plan`,
4. run execution with `run --all` on the generated file.

Execution is sequential and fail-fast across phases.

Synopsis:

```bash
rundown do "<seed-text>" "<markdown-file>" [options] -- <command>
rundown do "<seed-text>" "<markdown-file>" [options] --worker <pattern>
```

Options:

- Supports `make`-phase options for bootstrap (`--scan-count`, `--dry-run`, `--print-prompt`, `--vars-file`, `--var`, `--worker`, etc.).
- Supports run-like execution options for the final phase (`--sort`, `--verify/--no-verify`, `--repair-attempts`, `--commit`, `--on-complete`, `--on-fail`, `--redo`, `--clean`, `--rounds`, and related flags).

Examples:

```bash
# End-to-end: create, enrich, plan, then execute all generated tasks
rundown do "ship release checklist" "docs/release.md"

# Same flow with explicit clean execution behavior
rundown do "ship release checklist" "docs/release.md" --clean --rounds 2
```

### `rundown query <text>`

See the command-focused reference: [docs/cli-query.md](cli-query.md).

### `rundown memory-view <source>`

See the command-focused reference: [docs/cli-memory-view.md](cli-memory-view.md).

### `rundown memory-validate <source>`

See the command-focused reference: [docs/cli-memory-validate.md](cli-memory-validate.md).

### `rundown memory-clean <source>`

See the command-focused reference: [docs/cli-memory-clean.md](cli-memory-clean.md).

### `rundown worker-health`

Display persisted worker/profile health status and fallback eligibility snapshots.

The output includes current health entries and fallback-order snapshots used during worker resolution.

Synopsis:

```bash
rundown worker-health [options]
```

Options:

| Option | Description | Default |
|---|---|---|
| `--json` | Print worker health status as JSON. | off |

Examples:

```bash
# Human-readable status
rundown worker-health

# Machine-readable snapshot
rundown worker-health --json
```

### `rundown unlock <source>`

Manually remove a stale per-source lockfile (`<source-dir>/.rundown/<basename>.lock`) for a Markdown source.

`unlock` is a safety command for lock recovery. It only removes locks that are not owned by a currently running process.

Behavior:

- If no lockfile exists for the source, exits `3`.
- If a lockfile exists and the recorded PID is still running, exits `1` and does not remove the lock.
- If a lockfile exists but the recorded PID is not running (stale lock), removes it and exits `0`.

Examples:

```bash
rundown unlock roadmap.md
rundown unlock docs/todos.md
```

### `rundown workspace`

See the command-focused reference: [docs/cli-workspace.md](cli-workspace.md).

### `rundown next <source>`

Show the next runnable unchecked task without executing it.

Example:

```bash
rundown next docs/
```

### `rundown list <source>`

List unchecked tasks across the source.

Use `--all` to include checked tasks in the output.

Nested checkbox tasks and non-checkable list items are rendered under their parent task with indentation, preserving source order.

Example:

```bash
rundown list .
rundown list roadmap.md --all
```

Example hierarchical output:

```text
TODO.md:1 [#0] Release prep (blocked — has unchecked subtasks)
  TODO.md:2 - Confirm target branch
  TODO.md:3 [#1] Rewrite README opening
    TODO.md:4 [#2] Capture before/after screenshots
```

In this example, `Confirm target branch` is a non-checkable detail item, and the checkbox children are shown as nested task lines.

### `rundown artifacts`

See the command-focused reference: [docs/cli-artifacts.md](cli-artifacts.md).

### `rundown log`

See the command-focused reference: [docs/cli-log.md](cli-log.md).

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

Create `.rundown/` with default templates, plus `vars.json` and `config.json` initialized as empty JSON objects (`{}`).

Example:

```bash
rundown init
```

### `rundown with <harness>`

Configure worker settings in `.rundown/config.json` from a known harness preset.

Use this as the fastest onboarding path when you want runnable defaults without manually editing JSON.

Supported harness presets:

- `opencode`
- `claude`
- `gemini`
- `codex`
- `aider`
- `cursor`
- `pi`

Behavior:

- Validates `<harness>` against known presets (case-insensitive aliases are accepted).
- Creates `.rundown/config.json` when missing.
- Updates preset-targeted keys (`workers.default`, `workers.tui`, and `commands.discuss`) without clobbering unrelated config.
- Preserves other config sections (`workspace`, `trace`, run defaults, tool directories, and other command settings).
- Prints configured keys and resolved config path.
- Unknown harness exits non-zero with an actionable error and the supported preset list.

Examples:

```bash
# Canonical OpenCode onboarding
rundown with opencode

# Alias matching is case-insensitive
rundown with Claude-Code
```

OpenCode conventions applied by `rundown with opencode`:

- Deterministic commands (`run`, `plan`, `research`, `reverify`) use `opencode run` with file-first prompt transport (`$file` + `$bootstrap`).
- Interactive discussion (`discuss`) uses base `opencode`.
- The deterministic/interactive split is persisted via `workers.default`, `workers.tui`, and `commands.discuss`.

### `rundown intro`

Display a built-in introduction to rundown concepts, workflow, and command families.

Use `intro` for quick onboarding when you want a concise orientation before running task commands.

Synopsis:

```bash
rundown intro
rd intro
```

Examples:

```bash
# Show introduction and workflow guidance
rundown intro
```

### `rundown config`

Manage rundown configuration without editing JSON files manually.

Scope model:

- `local`: project config file at `<config-dir>/config.json`.
- `global`: user-level defaults file (cross-workspace baseline).
- `effective`: merged read view (`built-in defaults -> global -> local -> CLI overrides`).

Global path conventions:

- Linux: `$XDG_CONFIG_HOME/rundown/config.json` (fallback: `~/.config/rundown/config.json`)
- macOS: `~/Library/Application Support/rundown/config.json` (discovery also checks `$XDG_CONFIG_HOME/rundown/config.json` then `~/.config/rundown/config.json`)
- Windows: `%APPDATA%\rundown\config.json` (discovery also checks `%LOCALAPPDATA%\rundown\config.json`, `%USERPROFILE%\AppData\Roaming\rundown\config.json`, then `~/.config/rundown/config.json`)

Discovery behavior:

- `config path --scope global` prints the canonical path for the current platform.
- Global/effective reads use deterministic ordered discovery and load the first existing file.
- If no global file exists, global scope is treated as empty.

Layer merge semantics (`global` -> `local`):

- Object sections merge by key so local can override only the keys it sets.
- Array-valued fields are replace-by-value (no concatenation): local replaces global when present.
- Map entries (`commands.<name>`, `profiles.<name>`) are replace-by-entry: same key in local replaces global key.
- Nested health policy objects deep-merge by key (`cooldownSecondsByFailureClass`, `unavailableReevaluation`).

Edge-case behavior:

- Missing sections do not clear lower-priority values; only explicitly provided keys override.
- Empty nested objects (for example `{}`) do not erase lower-priority nested values.
- Invalid JSON or schema at the discovered global path fails fast with a path-specific error before applying local merges.
- If both global and local omit a section, that section is omitted from effective output.

Scope defaults:

- read operations (`get`, `list`): `effective`
- write operations (`set`, `unset`): `local`

`effective` is read-only.

Synopsis:

```bash
rundown config get <key> [options]
rundown config list [options]
rundown config set <key> <value> [options]
rundown config unset <key> [options]
rundown config path [options]
```

Subcommands:

| Subcommand | Description |
|---|---|
| `get <key>` | Read one config value by dotted path (for example `workers.default`). |
| `list` | Print all keys/values for a scope. |
| `set <key> <value>` | Set a value at key path in writable scope (`local` or `global`). |
| `unset <key>` | Remove a key from writable scope (`local` or `global`). |
| `path` | Print resolved config file path for a scope. |

Common options:

| Option | Description | Applies to |
|---|---|---|
| `--scope <effective|local|global>` | Select config scope. | all subcommands |
| `--json` | Emit JSON output (stable machine format). | `get`, `list` |
| `--show-source` | Include source attribution for `effective` reads (`built-in`, `global`, `local`, `flag`). | `get`, `list` |
| `--type <auto|string|number|boolean|json>` | Parse mode for `<value>`. | `set` |

Behavior notes:

- `set`/`unset` fail fast when `--scope effective` is requested.
- `set --type auto` parses JSON literals (`true`, `42`, `{"k":1}`, `[...]`) and falls back to string.
- `set --type json` requires `<value>` to be valid JSON.
- `get` exits non-zero when key is missing in selected scope.
- `list --scope effective --show-source` includes per-key attribution where practical.

Examples:

```bash
# Read merged value (global + local + defaults)
rundown config get workers.default

# Inspect local-only override
rundown config get workers.default --scope local

# Set project-local default worker
rundown config set workers.default '["opencode","run","--file","$file","$bootstrap"]' --type json --scope local

# Set user-level global command override
rundown config set commands.plan '["opencode","run","--file","$file","$bootstrap","--model","gpt-5.3-codex"]' --type json --scope global

# Remove a local command override so global/default can apply
rundown config unset commands.plan --scope local

# List merged config with attribution
rundown config list --scope effective --show-source --json

# Show where global config is stored on this machine
rundown config path --scope global
```

## Worker command forms

`rundown` separates the source to scan from the worker command that performs the task.

Preferred forms:

```bash
rundown run <source> -- <command>
rundown run <source> --worker <pattern>
```

If both are provided, `--worker` takes precedence.

`--worker` is optional when rundown can resolve a worker from `.rundown/config.json`.

With a freshly initialized empty config (`{}`), no worker is resolved by default. In that case, provide one explicitly using either `--worker <pattern>` or `-- <command>`.

Worker resolution cascade (lowest to highest priority):

- `workers.default` in `.rundown/config.json` (or `workers.tui` when mode is `tui`)
- `commands.<command>` in `.rundown/config.json` (`run`, `plan`, `discuss`, `help`, `research`, `reverify`, `verify`, `memory`)
- `commands.tools.<toolName>` in `.rundown/config.json` for tool-prefix-specific worker overrides (for example `tools.post-on-gitea`)
- Markdown frontmatter `profile: <name>`
- Parent directive item `- profile=<name>` for child checkbox tasks
- Parent directive item `- cli-args: <args>` for child `cli:` checkbox tasks (appends `<args>` to each child inline CLI command)
- Prefix modifier `profile=<name>` on the selected checkbox task
- CLI `--worker` or separator form `-- <command>`

Profile behavior:

- Named profiles are defined under `profiles` in `.rundown/config.json`.
- A resolved profile contributes a full worker command array and replaces the current command at its precedence level.

## Unified tool prefixes

Checkbox task prefixes resolve through one tool pipeline.

Task form:

```md
- [ ] <tool-name>: <payload>
```

Built-in handler aliases:

- Verify-only: `verify:`, `confirm:`, `check:`
- Memory capture: `memory:`, `memorize:`, `remember:`, `inventory:`
- Fast execution (skip verification): `fast:`, `raw:`, `quick:`
- Conditional control flow (skip remaining siblings when condition is true): `optional:`, `skip:`, `end:`, `return:`, `quit:`, `break:`
- Include markdown file execution: `include:`
- Outer retry wrapper: `force:`

`optional:` is the canonical control-flow prefix in v1, with `skip:` as the preferred concise alias.
Compatibility aliases `end:`, `return:`, `break:`, and `quit:` remain supported in v1 for backward compatibility.
All listed control-flow aliases resolve to the same handler and behavior.

Built-in modifier:

- `profile=`

Composition examples:

```md
- [ ] verify: docs are up to date
- [ ] profile=fast, verify: tests pass
- [ ] profile=complex; memory: capture architecture decisions
```

Composition rules:

- Prefix segments split on `, ` or `; ` only when the next segment starts with a known tool name.
- Modifier tools apply left-to-right and patch execution context.
- Handler tools are terminal and run task behavior.
- Modifier-only chains still run default execution/verification with the patched context.

Intent prefix notes:

- `fast:`, `raw:`, and `quick:` are aliases that force execution without verification for that task (the inverse of `verify:`).
- `fast:` / `raw:` / `quick:` can also be used as directive parents (`- fast:` / `- raw:` / `- quick:`) so child checkbox tasks inherit fast-execution intent.
- `cli-args:` can be used as a directive parent (`- cli-args: <args>`) so child `cli:` checkbox tasks inherit appended CLI arguments.
- Prefix detection is case-insensitive and allows whitespace around `:`.
- For mixed intent prefixes, the first explicit prefix in task text wins (for example `verify: fast: ...` stays verify-only, `fast: verify: ...` stays fast-execution).

## Memory capture prefixes

If a selected task starts with a memory prefix, rundown treats it as a memory-capture tool task.

Supported aliases:

- `memory:`
- `memorize:`
- `remember:`
- `inventory:`

Prefix parsing rules:

- Matching is case-insensitive.
- Whitespace around `:` is allowed.
- The payload is everything after the first matched prefix.
- Empty payload fails with exit code `1`.

Execution behavior:

- Rundown executes the normalized payload as the worker prompt.
- On successful worker output, rundown appends the captured content to source-local memory.
- Memory-capture tasks still follow normal run lifecycle behavior (verification/repair/checkbox handling) unless overridden by flags.

Storage layout (source-local):

- Memory body file: `<source-dir>/.rundown/<source-basename>.memory.md`
- Memory index file: `<source-dir>/.rundown/memory-index.json`

Index metadata is keyed by canonical absolute source path and stores a compact summary for each source (plus diagnostic metadata such as update time).

Example:

```md
- [ ] memory: capture release checklist assumptions and deployment caveats
```

## Custom tool prefixes

You can define custom task prefixes by adding `.js` handlers or `.md` templates under configured tool directories (`toolDirs` in `config.json`, default `<config-dir>/tools/`).

Each tool file name becomes a runnable prefix:

- `.rundown/tools/post-on-gitea.js` -> `post-on-gitea:`
- `.rundown/tools/summarize.md` -> `summarize:`

Task form:

```md
- [ ] <tool-name>: <payload>
```

Execution behavior for `.md` tools:

- Rundown resolves `<tool-name>` to `<config-dir>/tools/<tool-name>.md`.
- The tool template is rendered with standard task template vars plus `{{payload}}`.
- The rendered prompt is sent to the worker.
- Worker output is parsed for unchecked TODO items (`- [ ] ...`) and inserted as child tasks.
- The tool task is treated as structural expansion and does not run verification itself.

Resolution rules:

- Project `.js` tools are resolved first and can override built-ins.
- Built-in tools are resolved next (`verify:`/`confirm:`/`check:`, memory aliases, fast/raw/quick aliases, `optional:`/`skip:` control-flow aliases, `include:`, `profile=`, `force:`).
- Project `.md` tools are resolved after built-ins (for non-built-in names).
- Tool matching is case-insensitive and checks the text before the first `:`.
- Unknown prefixes fall back to normal `execute-and-verify` behavior.
- Empty tool payload fails with exit code `1`.

`cli:` and `rundown:` are parser-level task forms and are not resolved through the tool pipeline.

Example:

```md
- [ ] post-on-gitea: open an issue for the broken auth callback flow
```

With `.rundown/tools/post-on-gitea.md` present, rundown runs that template and expands the task into child TODO items.

## Common options

### Verification and repair

- `--no-verify` — skip verification
- `--only-verify` — verify without executing first
- verify-only task text auto-skips execute phase (for example `verify: ...`, `confirm: ...`, `check: ...`)
- fast-execution task text auto-skips verification (for example `fast: ...`, `raw: ...`, `quick: ...`), even when global `--verify` is enabled
- `--force-execute` — override verify-only auto-skip and run execute phase anyway
- `force: <task>` — wrap a task in an outer retry loop that reruns the full iteration on retryable failure
- `force: <attempts>, <task>` — same as above with per-task retry limit override
- `--force-attempts <n>` — default outer retry attempts for `force:` tasks when count is omitted
- `--force-execute` and `force:` are independent: `--force-execute` decides whether verify-only text still runs execution, while `force:` decides whether a failed iteration is retried
- `force:` is a no-op in `--mode detached`: detached task dispatch returns immediate success (`continueLoop: false`, `exitCode: 0`), so outer retries never trigger
- `--repair-attempts <n>` — retry repair up to `n` times
- `--no-repair` — disable repair explicitly

When verification fails, rundown surfaces the failure reason in user-visible output at each stage:

- Initial failure before repair: `Verification failed: <reason>. Running repair (N attempt(s))...`
- After each failed repair attempt: `Repair attempt N failed: <reason>`
- Final failure (including immediate `--no-repair`): `Last validation error: <reason>`

If the worker does not provide details, rundown prints fallback reasons (for example `Verification worker exited with code N.` or `Verification failed (no details).`).

### Execution mode

- `--mode wait` — start the worker and wait
- `--mode tui` — start an interactive terminal session and continue after exit
- `--mode detached` — start the worker without waiting

### Worker patterns and prompt delivery

Rundown always writes the rendered task prompt to a runtime file and supports worker pattern placeholders:

- `$file` — replaced with the prompt file path on disk
- `$bootstrap` — replaced with a short instruction telling the worker to read the prompt file

If neither `$file` nor `$bootstrap` appears in the worker pattern, rundown appends `$file` as the final argument (backward-compatible default).

Important: `$file` and `$bootstrap` are pure string substitutions inside the command line. They do not imply any particular CLI semantics for the target worker. For example, `--file $file` passes the prompt file path via the worker's `--file` flag, but if that worker also requires a separate message or prompt argument, you must supply one (for example, by adding `$bootstrap` as a positional argument).

Examples:

```bash
# Attach prompt file and provide a bootstrap message for the worker
rundown run roadmap.md --worker 'opencode run --file $file $bootstrap'

# Worker receives bootstrap text as its prompt flag
rundown run roadmap.md --worker 'opencode run --prompt "$bootstrap" --file $file'

# No placeholder used -> rundown appends $file automatically
rundown run roadmap.md --worker 'opencode run'
```

### `rundown research <markdown-file>`

Enrich a single Markdown document with context and structure before planning.

`research` rewrites the document body with expanded feature detail, implementation context, design constraints, and planning scaffolding. It is intentionally upstream of `plan`:

1. author drafts a thin feature doc,
2. `rundown research <source>` enriches it,
3. `rundown plan <source>` appends actionable TODOs,
4. `rundown run <source>` executes tasks.

Input rules:

- Exactly one file path is required.
- File extension must be `.md` or `.markdown`.
- Directories and globs are rejected for `research`.

Behavior and safety guards:

- Worker output is treated as the full replacement Markdown document.
- Existing checkbox state must remain unchanged, or the write is rejected and rolled back.
- New unchecked TODO items (`- [ ]`) are not allowed in research output.
- `research` runs a single pass (no `--scan-count` convergence loop).

Options:

| Option | Description | Default |
|---|---|---|
| `--mode <mode>` | Research execution mode: `wait`, `tui`. | `wait` |
| `--force-unlock` | Remove stale source lockfile before acquiring the research lock. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render research prompt + execution intent and exit without running the worker. | off |
| `--print-prompt` | Print the rendered research prompt and exit `0` without running the worker. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `.rundown/runs/` even on success. | off |
| `--show-agent-output` | Show worker stdout/stderr during execution (hidden by default). | off |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror them to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |

Worker resolution:

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `research` resolves the worker from `.rundown/config.json` using the standard cascade.
- Custom research prompts can be supplied via `.rundown/research.md`; otherwise the built-in default research template is used.

Examples:

```bash
# Enrich a thin spec before planning
rundown research docs/spec.md

# Inspect research prompt only
rundown research docs/spec.md --print-prompt

# Dry-run with explicit vars
rundown research docs/spec.md --dry-run --vars-file --var ticket=ENG-42
```

### Command-output block expansion

- `--ignore-cli-block` — skip execution of markdown fenced `cli` blocks during prompt expansion (blocks remain unexpanded)
- `--cli-block-timeout <ms>` — per-command timeout for fenced `cli` block execution (default `30000`, `0` disables timeout)

These options apply to `run`, `discuss`, `plan`, `explore`, `make`, `reverify`, and `research`.

During fenced `cli` block execution, variables loaded from `--var` and `--vars-file` are available in the spawned shell environment as `RUNDOWN_VAR_<UPPERCASE_KEY>`.

### Sorting

- `--sort name-sort`
- `--sort none`
- `--sort old-first`
- `--sort new-first`

### Variables

- `--var key=value` — inject a template variable
- `--vars-file path/to/file.json` — load template variables from JSON
- `--vars-file` — load `<config-dir>/vars.json`

Direct `--var` entries override values loaded from `--vars-file`.

Variable environment export behavior:

- User variables are also exported to child shell processes as `RUNDOWN_VAR_<NAME>`.
- `<NAME>` is the template variable key uppercased (for example `--var db_host=localhost` -> `RUNDOWN_VAR_DB_HOST=localhost`).
- This applies to fenced `cli` block expansion and inline `cli:` task execution.

### Artifacts

- `--keep-artifacts` — keep the run folder under `<config-dir>/runs/`

### Planning

- `--scan-count <n>` — set max clean-session plan scans for `plan` (positive integer)
- `--deep <n>` — add nested child-generation passes after top-level scans (non-negative integer)

### Listing

- `--all` — include checked and unchecked tasks in `list` output

### Git and hooks

These options are available on `rundown run`.

| Option | Description | Default |
|---|---|---|
| `--commit` | Auto-commit current worktree changes after successful completion (excluding transient `.rundown/runs` artifacts). | off |
| `--commit-mode <per-task|file-done>` | Commit timing for `--commit`: `per-task` (default) or `file-done` (effective run-all only via `--all`/`all`/`--redo`/`--clean`). | `per-task` |
| `--commit-message <template>` | Commit message template (supports `{{task}}` and `{{file}}`). | `rundown: complete "{{task}}" in {{file}}` |
| `--on-complete <command>` | Run a shell command after successful task completion. | unset |
| `--on-fail <command>` | Run a shell command when a task fails (execution or verification failure). | unset |
| `--show-agent-output` | Show worker stdout/stderr for execute/verify/plan stages (output is hidden by default). | off |
| `--all` | Run all tasks sequentially instead of stopping after one. Stops on failure. | off |
| `--redo` | Reset checked checkboxes in all resolved source files before task selection. Implies `--all`. | off |
| `--reset-after` | Reset all checkboxes in all resolved source files after run completion. | off |
| `--clean` | Shorthand for `--redo --reset-after`. | off |
| `--revertable` | Shorthand for `--commit --keep-artifacts`. | off |
| `--force-unlock` | Remove stale source lockfiles before acquiring run locks. Active locks held by live processes are not removed. | off |

`--commit-message` is only applied when `--commit` is enabled.

`--commit-mode` is only applied when `--commit` is enabled.

`--commit-mode file-done` is only valid in effective run-all flows (`run --all`, `all`, or implicit-all via `--redo`/`--clean`).

When `--commit` and `--reset-after` are combined, rundown applies post-run reset first, then performs the commit so git captures the clean (all-unchecked) state. In run-all with `--commit-mode file-done`, this is the deferred final commit.

Examples:

```bash
rundown run docs/todos/phase-3.md --commit
rundown run docs/todos/phase-3.md --commit --commit-message "rundown: complete \"{{task}}\" in {{file}}"
rundown run docs/todos/phase-3.md --all --commit --commit-mode file-done
rundown run docs/todos/phase-3.md --on-complete "git push"
rundown run docs/todos/phase-3.md --commit --on-complete "npm run release:notes"
rundown run docs/todos/phase-3.md --on-fail "node scripts/notify-failure.js"
rundown run docs/todos/phase-3.md --all --commit --on-fail "node scripts/alert.js"
```

`--commit` stages and commits current worktree changes (excluding transient `.rundown/runs` artifacts), with a structured message tied to the completed task context:

```
rundown: complete "Rewrite the README intro" in docs/README.md
```

This makes task history searchable via `git log --grep="rundown:"`.

`--on-complete` receives task metadata as environment variables:

| Variable | Value |
|---|---|
| `RUNDOWN_TASK` | The task text |
| `RUNDOWN_FILE` | Absolute path to the Markdown file |
| `RUNDOWN_LINE` | 1-based line number |
| `RUNDOWN_INDEX` | Zero-based task index |
| `RUNDOWN_SOURCE` | The original source argument |

Both `--commit` and `--on-complete` are non-fatal: if they fail, the task is still marked complete and `rundown` exits `0` with a warning.

When both are used, `--commit` runs first so that `--on-complete` can safely push or tag.

`--on-fail` runs the same way but fires only when a task fails (exit code `1` or `2`). It receives the same environment variables as `--on-complete`. The hook is non-fatal: its exit code does not change the run's exit code.

For `run`, source-file locks remain held for the full task lifecycle, including `--on-complete` and `--on-fail` hook execution. Locks are released only after hook processing and finalization complete.

### Run all mode

`--all` (or `all <source>`) processes tasks sequentially. After each successful task, the next unchecked task is selected and run. The loop stops when:

- All tasks are complete — exits `0`.
- A task fails execution or verification — exits `1` or `2`.

`--on-complete` fires after each successful task. `--on-fail` fires once on the task that caused the loop to stop.

`--commit` timing in run-all mode:

- `--commit --commit-mode per-task` (default): commit after each successful task.
- `--commit --commit-mode file-done`: one deferred final commit after full successful run completion.
- For `file-done`, deferred commit runs after `--reset-after` (if set) and before lock release.
- For `file-done`, no final commit is attempted on early termination (execution failure, verification failure, interruption, cancellation) or on `--dry-run`.

Example:

```bash
rundown run roadmap.md --all --commit --commit-mode file-done --on-fail "node scripts/alert.js"
```

### Checkbox reset flags

- `--redo` resets checked checkboxes before selecting tasks. This is source-scoped across every file resolved from `<source>` (single file, directory, or glob).
- `--redo` implies `--all`; rundown emits an info message and runs all tasks sequentially.
- `--reset-after` resets checkboxes after run completion. In `--all` mode it still runs after a mid-run task failure so files end clean.
- `--reset-after` does not run for interrupted sessions (`SIGINT`/`SIGTERM`).
- `--clean` is a convenience alias for `--redo --reset-after`.
- `--redo`, `--reset-after`, and `--clean` cannot be combined with `--only-verify` (returns exit code `1`).
- With `--dry-run`, reset phases are reported but files are not mutated.
- With `--rounds > 1`, each round is an independent clean pass; `force:` outer retries are scoped per task within the current round and do not carry retry state into later rounds.

Examples:

```bash
# Re-run from the top of every checked task in the resolved source set
rundown run docs/todos.md --redo

# Run tasks, then always leave files unchecked
rundown run "docs/**/*.md" --all --reset-after

# Canonical reusable runbook flow: clean before and after
rundown run runbook.md --clean
```

### Inspection and dry runs

- `--dry-run` — select the task and render the prompt, then print what command would run and exit without executing, verifying, repairing, or editing Markdown files.
- `--print-prompt` — print the fully rendered prompt and exit without executing the worker.

Behavior notes:

- If both flags are provided, `--print-prompt` takes precedence.
- For `run`, `--print-prompt` and `--dry-run` target the execute prompt by default.
- For `run --only-verify`, `--print-prompt` and `--dry-run` target the verify prompt instead.
- For `reverify`, `--print-prompt` and `--dry-run` target the verify prompt for the resolved historical task.
- `force:` outer retries are inert in `--dry-run` and `--print-prompt` flows for `run`: those modes return exit `0` after rendering/output-only handling, so no retry attempts are triggered.
- For `reverify --all` or `reverify --last <n>`, `--print-prompt` is not supported and returns exit code `1`; use `--dry-run` to inspect all selected runs.
- For `plan`, both flags apply to the planner prompt.
- For `explore`, both flags apply to the research and planner prompts.
- For `make`, both flags apply to the research/plan phase prompts.
- For `research`, both flags apply to the research prompt.
- Fenced `cli` blocks run during `--print-prompt` so printed prompts match worker-visible prompts (unless `--ignore-cli-block` is set).
- Fenced `cli` blocks do not run during `--dry-run`; prompts remain unexpanded.
- For inline `cli:` tasks on `run`, `--print-prompt` prints the inline command and exits without executing it.
- Worker command validation still applies before execution for flows that require a worker command. Invalid or missing worker command input can still return exit code `1`.
- If no CLI worker is provided and no worker is resolvable from config, the command exits `1` with: `No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.`

Examples:

```bash
rundown run roadmap.md --dry-run
rundown run roadmap.md --print-prompt
rundown run roadmap.md --only-verify --dry-run
rundown run roadmap.md --only-verify --print-prompt
rundown plan roadmap.md --dry-run
rundown plan roadmap.md --print-prompt
```

## Inline CLI tasks

If the selected task begins with `cli:`, `rundown` executes it directly instead of sending it to the external worker.

The command runs from the directory containing the Markdown file, not the current working directory. This makes inline CLI tasks portable — they behave the same regardless of where `rundown` is invoked from.

Inline `cli:` commands also receive template variables in their process environment as `RUNDOWN_VAR_<UPPERCASE_KEY>` (from both `--var` and `--vars-file`).

Example:

```md
- [ ] cli: npm test
```

With a parent directive:

```md
- cli-args: --worker opencode
  - [ ] cli: npm run build
  - [ ] cli: npm test
```

Both `cli:` commands run with `--worker opencode` appended.

## Inline rundown delegation tasks

If the selected task begins with `rundown:`, `rundown` delegates execution to a nested `rundown run` call instead of sending the task to the external worker.

Syntax:

```md
- [ ] rundown: Test.md --optional arg-val
```

Equivalent delegated command shape:

```bash
rundown run <file> [args...]
```

Like `cli:` tasks, delegated `rundown:` tasks run from the directory containing the Markdown file.

Examples:

```md
- [ ] rundown: docs/child.md
- [ ] rundown: docs/child.md --no-verify --repair-attempts 0
- [ ] rundown: docs/child.md
```

Forwarded flags:

- `--worker <pattern>`
- `--keep-artifacts`
- `--show-agent-output`
- verification mode: `--verify` or `--no-verify`
- repair mode: `--no-repair` or `--repair-attempts <n>`

Forwarding behavior:

- Parent `rundown run` flags are forwarded by default when not already provided inline.
- Inline `rundown:` args take precedence over forwarded parent flags.
- Legacy inline `--retries <n>` is accepted as an alias for `--repair-attempts <n>`.

## Shell guidance

### PowerShell 5.1

Prefer `--worker` because it avoids argument splitting issues around `--`.

Example:

```powershell
rundown run docs/ --worker "opencode run --file $file $bootstrap"
```

### Large prompts on Windows

Use a `$file` worker pattern for robust prompt delivery:

```powershell
rundown run docs/
```

## Practical default for OpenCode

A clean setup is:

- `wait` mode with `opencode run`
- `tui` mode with `opencode`
- worker pattern with `$file` and `$bootstrap` for staged prompt files

Examples:

```bash
rundown run roadmap.md
rundown run roadmap.md --mode tui
```

## Exit codes

- `0` — command completed successfully
- `1` — execution error
- `2` — validation failed (stderr includes the surfaced verification failure reason)
- `3` — no actionable target

`rundown unlock` follows the same contract:

- `0` when a stale lock was released
- `1` when the lock is currently held by a live process
- `3` when no lockfile exists for the target source

`rundown reverify` uses the same exit-code contract:

- `2` when verification still fails after configured repair attempts (or immediately with `--no-repair`)
- `3` when no completed task can be resolved from the selected run artifacts

`rundown revert` uses:

- `1` when git undo operations fail (for example dirty worktree, revert conflict, invalid reset preconditions)
- `3` when input is invalid or no revertable runs can be resolved (missing `--commit`/`--keep-artifacts` lineage)

`rundown discuss` uses:

- `1` when discuss execution fails (for example worker invocation failure)
- `3` when no unchecked task can be resolved from the source
