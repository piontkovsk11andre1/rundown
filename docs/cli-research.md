# CLI: `research`

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
