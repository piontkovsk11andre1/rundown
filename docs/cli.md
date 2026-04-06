# CLI

## Global option

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies (for example, `init` creates one locally).

Examples:

```bash
# Monorepo: run from a package, but keep shared rundown config at repo root
cd packages/api
rundown --config-dir ../../.rundown run TODO.md -- opencode run

# CI: use a workspace-mounted config outside the repo checkout
rundown --config-dir /workspace/rundown-config run docs/todos.md --worker "opencode run --file $file $bootstrap"
```

## Main commands

### `rundown run <source>`

Scan a file, directory, or glob, select the next runnable task, execute it, verify it, optionally repair it, and mark it complete only after verification succeeds.

With `--all` (or the shorthand `all` command), process tasks sequentially until all are complete or a failure occurs.

Agent stdout/stderr is hidden by default. Use `--show-agent-output` to display worker output for `execute`, `verify`, and `plan` stages while keeping `discuss` worker output silent.

Examples:

```bash
rundown run roadmap.md -- opencode run
rundown run docs/ -- opencode run
rundown run "notes/**/*.md" -- opencode run
rundown run roadmap.md --all -- opencode run
rundown run roadmap.md --redo -- opencode run
rundown run roadmap.md --reset-after -- opencode run
rundown run roadmap.md --clean -- opencode run
rundown all roadmap.md -- opencode run
rundown run tasks.md --show-agent-output --worker "opencode run --file $file $bootstrap"
```

PowerShell-safe form:

```powershell
rundown run docs/ --worker "opencode run --file $file $bootstrap"
rundown run docs/ --all --worker "opencode run --file $file $bootstrap"
rundown all docs/ --worker "opencode run --file $file $bootstrap"
rundown run docs/ --show-agent-output --worker "opencode run --file $file $bootstrap"
```

Agent output notes (`run --show-agent-output`):

- Default behavior (option omitted): suppress worker-derived `text` and `stderr` transcript output across stages.
- With `--show-agent-output`: show worker-derived `text` and `stderr` transcript output for `execute`, `verify`, and `plan` stages (including inline `cli:` task stdout/stderr).
- `discuss` remains silent for worker transcript output even when `--show-agent-output` is set.
- Still visible: rundown lifecycle/status messages (`info`, `warn`, `error`, `success`, `task`).
- Still visible: hook output from `--on-complete` and `--on-fail` (intentionally out of scope for this option).
- Artifacts/traces still capture output for audit/debug; terminal suppression does not disable persistence.

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
| `--show-agent-output` | Show worker stdout/stderr for execute/verify/plan stages (output is hidden by default). | off |
| `--force-unlock` | Remove stale source lockfile before acquiring discuss lock. Active locks held by live processes are not removed. | off |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Examples:

```bash
rundown discuss roadmap.md -- opencode
rundown discuss docs/ --worker "opencode"
rundown discuss tasks.md --mode wait --worker "opencode run --file $file $bootstrap"
rundown discuss roadmap.md --print-prompt --worker "opencode run --file $file $bootstrap"
rundown discuss roadmap.md --dry-run --worker "opencode --prompt=$bootstrap"
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
rundown reverify -- opencode run
rundown reverify --all -- opencode run
rundown reverify --last 3 -- opencode run
rundown reverify --last 3 --oldest-first -- opencode run
rundown reverify --run latest -- opencode run
rundown reverify --run run-20260319T222645632Z-04e84d73 --repair-attempts 2 -- opencode run
rundown reverify --run latest --no-repair --worker "opencode run --file $file $bootstrap"
rundown reverify --run run-20260319T222645632Z-04e84d73 --no-repair -- opencode run
rundown reverify --print-prompt --worker "opencode run --file $file $bootstrap"
rundown reverify --dry-run --worker "claude -p $bootstrap"
```

### `rundown revert`

Undo previously completed tasks by reverting the git commit recorded in saved run artifacts.

By default, `revert` targets the latest completed+committed run in the current repository (`--run latest`) and uses `--method revert`.

Revertable run requirements:

- The original run status is `completed`.
- The original run used `--commit`.
- The original run used `--keep-artifacts` so `run.json` still exists.
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
rundown revert -- opencode run
rundown revert --run latest -- opencode run
rundown revert --run run-20260319T222645632Z-04e84d73 -- opencode run
rundown revert --last 3 --method revert -- opencode run
rundown revert --all --dry-run --worker "opencode run --file $file $bootstrap"
rundown revert --last 2 --method reset -- opencode run
```

### `rundown plan <markdown-file>`

Run document-level TODO synthesis on a single Markdown document using the planner template.

For thin specs, run `research` first so `plan` has richer context:

```bash
rundown research docs/spec.md -- opencode run
rundown plan docs/spec.md --scan-count 3 -- opencode run
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
- Run metadata includes convergence fields (`planConvergenceOutcome`, `planConverged`, `planScanCapReached`, plus scan counts).
- Failed planning runs keep artifacts automatically.
- Successful runs are pruned by default unless `--keep-artifacts` is set.

Examples:

```bash
# Basic plan run
rundown plan roadmap.md --scan-count 3 -- opencode run

# No TODOs yet: bootstrap actionable TODOs, then converge
rundown plan docs/spec.md --scan-count 3 -- opencode run

# Existing TODOs: append missing implementation items only
rundown plan docs/migration.md --scan-count 2 -- opencode run

# Add one nested layer of child TODOs after top-level scans
rundown plan docs/spec.md --scan-count 3 --deep 1 -- opencode run

# Add two nested layers (children, then grandchildren)
rundown plan docs/spec.md --scan-count 3 --deep 2 -- opencode run

# PowerShell-safe worker form
rundown plan docs/spec.md --scan-count 2 --worker "opencode run --file $file $bootstrap"

# PowerShell-safe deep planning
rundown plan docs/spec.md --scan-count 2 --deep 2 --worker "claude -p $bootstrap"
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
rundown make "please do something" "8. Do something.md" -- opencode run

# Use .markdown extension
rundown make "Draft migration plan" "docs/migration.markdown" --worker "opencode run --file $file $bootstrap"

# Preview prompts without running workers
rundown make "Release prep" "docs/release-prep.md" --print-prompt --worker "opencode --prompt=$bootstrap"
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

Inspect or clean saved runtime artifact folders under `<config-dir>/runs/`.

Options:

| Option | Description |
|---|---|
| `--json` | Output artifact information as JSON. |
| `--failed` | Show only failed runs. |
| `--open <runId>` | Open a specific run folder by ID (use `latest` for the most recent run). |
| `--clean` | Delete saved run folders. |
| `--clean --failed` | Delete only failed run folders. |

Examples:

```bash
rundown artifacts
rundown artifacts --json
rundown artifacts --failed
rundown artifacts --open latest
rundown artifacts --clean --failed
```

### `rundown log`

Show completed run history in a compact, one-line-per-run format to help pick revert targets.

Default behavior:

- Shows only runs with status `completed`.
- Orders runs newest-first (same order as saved artifacts metadata).
- Prints one compact line per run: short run ID, relative timestamp, status, task summary, source, command, commit SHA (if present), and revertable indicator.
- Non-revertable entries are dimmed in terminal output.

Options:

| Option | Description |
|---|---|
| `--revertable` | Show only revertable runs (`status=completed` and metadata contains `extra.commitSha`). |
| `--command <name>` | Filter by command name (for example `run`, `plan`, `revert`, `reverify`). |
| `--limit <n>` | Show only the first `n` matching runs. |
| `--json` | Print matching runs as JSON for machine consumption. |

Examples:

```bash
rundown log
rundown log --revertable
rundown log --command run --limit 5
rundown log --json
```

`--json` outputs an array of run entries with fields such as `runId`, `shortRunId`, `commandName`, `status`, `relativeTime`, `taskSummary`, `source`, `commitSha`, `shortCommitSha`, `revertable`, `startedAt`, and `completedAt`.

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
- `make`: acquires phase locks in sequence (`research` lock first, then `plan` lock) while running create -> research -> plan.
- `research`: acquires before reading the source and holds through worker invocation plus document replacement/guard checks.
- `revert`: acquires before git undo operations for the target source set and releases after undo processing finishes.
- `discuss`: acquires before task-selection reads and holds for the full discussion lifecycle, including worker invocation and finalization.
- `list`, `next`, and `reverify`: no exclusive source lock (read-only behavior).

Stale lock detection:

- If lockfile exists and holder PID is still running, lock acquisition fails fast with holder details.
- If lockfile exists but holder PID is no longer running, the lock is treated as stale and can be removed.

Stale lock recovery:

- `run` and `plan` support `--force-unlock` to remove stale lockfiles before normal lock acquisition. Live-process locks are never removed by this flag.
- `unlock` provides manual stale-lock cleanup for one source file.

`unlock` exit behavior:

- `0`: stale lock removed
- `1`: lock held by live process (no change)
- `3`: no lockfile found for source

## Global output log (JSONL)

`rundown` also defines a process-wide append-only JSONL stream at `<config-dir>/logs/output.jsonl`.

When `--trace` is enabled on `run`, `discuss`, `reverify`, or `plan`, each artifact trace event (including LLM/worker-derived stages such as `agent.signals`, `agent.thinking`, and `analysis.summary`) is also appended to `<config-dir>/logs/trace.jsonl` as a cumulative stream.

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

- `defaults` in `.rundown/config.json`
- `commands.<command>` in `.rundown/config.json` (`run`, `plan`, `make`, `discuss`, `research`, `reverify`)
- Markdown frontmatter `profile: <name>`
- Parent directive item `- profile: <name>` for child checkbox tasks
- Prefix modifier `profile: <name>` on the selected checkbox task
- CLI `--worker` or separator form `-- <command>`

Profile behavior:

- Named profiles are defined under `profiles` in `.rundown/config.json`.
- A resolved profile contributes `workerArgs`, appended to the resolved base worker command.

## Unified tool prefixes

Checkbox task prefixes resolve through one tool pipeline.

Task form:

```md
- [ ] <tool-name>: <payload>
```

Built-in handler aliases:

- Verify-only: `verify:`, `confirm:`, `check:`
- Memory capture: `memory:`, `memorize:`, `remember:`, `inventory:`
- Fast execution (skip verification): `fast:`, `raw:`
- End control flow (skip remaining siblings when condition is true): `end:`, `return:`, `skip:`, `quit:`
- Include markdown file execution: `include:`

Built-in modifier:

- `profile:`

Composition examples:

```md
- [ ] verify: docs are up to date
- [ ] profile: fast, verify: tests pass
- [ ] profile: complex; memory: capture architecture decisions
```

Composition rules:

- Prefix segments split on `, ` or `; ` only when the next segment starts with a known tool name.
- Modifier tools apply left-to-right and patch execution context.
- Handler tools are terminal and run task behavior.
- Modifier-only chains still run default execution/verification with the patched context.

Intent prefix notes:

- `fast:` and `raw:` are aliases that force execution without verification for that task (the inverse of `verify:`).
- `fast:` / `raw:` can also be used as directive parents (`- fast:` / `- raw:`) so child checkbox tasks inherit fast-execution intent.
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
- Built-in tools are resolved next (`verify:`/`confirm:`/`check:`, memory aliases, fast/raw aliases, end aliases, `include:`, `profile:`).
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
- fast-execution task text auto-skips verification (for example `fast: ...`, `raw: ...`), even when global `--verify` is enabled
- `--force-execute` — override verify-only auto-skip and run execute phase anyway
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
rundown run roadmap.md --worker "opencode run --file $file $bootstrap"

# Worker receives bootstrap text as its prompt flag
rundown run roadmap.md --worker "claude -p $bootstrap"

# No placeholder used -> rundown appends $file automatically
rundown run roadmap.md --worker "my-agent"
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
rundown research docs/spec.md -- opencode run

# Inspect research prompt only
rundown research docs/spec.md --print-prompt --worker "opencode run --file $file $bootstrap"

# Dry-run with explicit vars
rundown research docs/spec.md --dry-run --vars-file --var ticket=ENG-42 --worker "claude -p $bootstrap"
```

### Command-output block expansion

- `--ignore-cli-block` — skip execution of markdown fenced `cli` blocks during prompt expansion (blocks remain unexpanded)
- `--cli-block-timeout <ms>` — per-command timeout for fenced `cli` block execution (default `30000`, `0` disables timeout)

These options apply to `run`, `discuss`, `plan`, `make`, and `reverify`.
These options also apply to `research`.

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
| `--force-unlock` | Remove stale source lockfiles before acquiring run locks. Active locks held by live processes are not removed. | off |

`--commit-message` is only applied when `--commit` is enabled.

`--commit-mode` is only applied when `--commit` is enabled.

`--commit-mode file-done` is only valid in effective run-all flows (`run --all`, `all`, or implicit-all via `--redo`/`--clean`).

When `--commit` and `--reset-after` are combined, rundown applies post-run reset first, then performs the commit so git captures the clean (all-unchecked) state. In run-all with `--commit-mode file-done`, this is the deferred final commit.

Examples:

```bash
rundown run docs/todos/phase-3.md --commit -- opencode run
rundown run docs/todos/phase-3.md --commit --commit-message "rundown: complete \"{{task}}\" in {{file}}" -- opencode run
rundown run docs/todos/phase-3.md --all --commit --commit-mode file-done -- opencode run
rundown run docs/todos/phase-3.md --on-complete "git push" -- opencode run
rundown run docs/todos/phase-3.md --commit --on-complete "npm run release:notes" -- opencode run
rundown run docs/todos/phase-3.md --on-fail "node scripts/notify-failure.js" -- opencode run
rundown run docs/todos/phase-3.md --all --commit --on-fail "node scripts/alert.js" -- opencode run
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
rundown run roadmap.md --all --commit --commit-mode file-done --on-fail "node scripts/alert.js" -- opencode run
```

### Checkbox reset flags

- `--redo` resets checked checkboxes before selecting tasks. This is source-scoped across every file resolved from `<source>` (single file, directory, or glob).
- `--redo` implies `--all`; rundown emits an info message and runs all tasks sequentially.
- `--reset-after` resets checkboxes after run completion. In `--all` mode it still runs after a mid-run task failure so files end clean.
- `--reset-after` does not run for interrupted sessions (`SIGINT`/`SIGTERM`).
- `--clean` is a convenience alias for `--redo --reset-after`.
- `--redo`, `--reset-after`, and `--clean` cannot be combined with `--only-verify` (returns exit code `1`).
- With `--dry-run`, reset phases are reported but files are not mutated.

Examples:

```bash
# Re-run from the top of every checked task in the resolved source set
rundown run docs/todos.md --redo --worker "opencode run --file $file $bootstrap"

# Run tasks, then always leave files unchecked
rundown run "docs/**/*.md" --all --reset-after --worker "opencode run --file $file $bootstrap"

# Canonical reusable runbook flow: clean before and after
rundown run runbook.md --clean --worker "opencode run --file $file $bootstrap"
```

### Inspection and dry runs

- `--dry-run` — select the task and render the prompt, then print what command would run and exit without executing, verifying, repairing, or editing Markdown files.
- `--print-prompt` — print the fully rendered prompt and exit without executing the worker.

Behavior notes:

- If both flags are provided, `--print-prompt` takes precedence.
- For `run`, `--print-prompt` and `--dry-run` target the execute prompt by default.
- For `run --only-verify`, `--print-prompt` and `--dry-run` target the verify prompt instead.
- For `reverify`, `--print-prompt` and `--dry-run` target the verify prompt for the resolved historical task.
- For `reverify --all` or `reverify --last <n>`, `--print-prompt` is not supported and returns exit code `1`; use `--dry-run` to inspect all selected runs.
- For `plan`, both flags apply to the planner prompt.
- For `make`, both flags apply to the research/plan phase prompts.
- For `research`, both flags apply to the research prompt.
- Fenced `cli` blocks run during `--print-prompt` so printed prompts match worker-visible prompts (unless `--ignore-cli-block` is set).
- Fenced `cli` blocks do not run during `--dry-run`; prompts remain unexpanded.
- For inline `cli:` tasks on `run`, `--print-prompt` prints the inline command and exits without executing it.
- Worker command validation still applies before execution for flows that require a worker command. Invalid or missing worker command input can still return exit code `1`.
- If no CLI worker is provided and no worker is resolvable from config, the command exits `1` with: `No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.`

Examples:

```bash
rundown run roadmap.md --dry-run -- opencode run
rundown run roadmap.md --print-prompt -- opencode run
rundown run roadmap.md --only-verify --dry-run -- opencode run
rundown run roadmap.md --only-verify --print-prompt -- opencode run
rundown plan roadmap.md --dry-run -- opencode run
rundown plan roadmap.md --print-prompt -- opencode run
```

## Inline CLI tasks

If the selected task begins with `cli:`, `rundown` executes it directly instead of sending it to the external worker.

The command runs from the directory containing the Markdown file, not the current working directory. This makes inline CLI tasks portable — they behave the same regardless of where `rundown` is invoked from.

Inline `cli:` commands also receive template variables in their process environment as `RUNDOWN_VAR_<UPPERCASE_KEY>` (from both `--var` and `--vars-file`).

Example:

```md
- [ ] cli: npm test
```

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
- [ ] rundown: docs/child.md --worker "opencode --prompt=$bootstrap"
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
rundown run docs/ --worker "opencode run --file $file $bootstrap"
```

## Practical default for OpenCode

A clean setup is:

- `wait` mode with `opencode run`
- `tui` mode with `opencode`
- worker pattern with `$file` and `$bootstrap` for staged prompt files

Examples:

```bash
rundown run roadmap.md -- opencode run
rundown run roadmap.md --mode tui -- opencode
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
