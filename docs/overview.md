# Overview

`rundown` is a Markdown-native task runtime.

It scans Markdown, selects the next runnable unchecked task, builds a structured prompt from the document context, runs a worker command or inline CLI task, verifies the result, optionally repairs it, and only then marks the checkbox complete.

## Core model

The workflow is intentionally simple:

1. **Select** the next runnable task.
2. **Execute** the task through a worker or inline CLI command.
3. **Verify** the result.
4. **Repair** and retry when verification fails.
5. **Complete** the task only after verification returns `OK`.

This makes the checkbox a consequence of successful work, not a guess.

## Prediction workflow model

In addition to execute/verify task running, rundown supports a prediction-oriented migration workflow:

- `start` bootstraps a design-first project workspace.
- `migrate` advances a numbered migration track and generates satellite artifacts.
- `undo` semantically reverses prior task outcomes using saved artifacts.
- `test` verifies assertion specs against predicted migration state.

Prediction migration naming convention:

- migration step: `0007-implement-feature.md`
- satellite artifact: `0007--snapshot.md`

The double-dash split distinguishes sequential migration steps from generated satellite files at the same migration number.

Predicted-state test semantics:

- `rundown test` evaluates whether an assertion is true in the predicted plan state built from migration context.
- It does not execute implementation tests against runtime code.
- This keeps test signals aligned with planning/migration intent before implementation is fully applied.

## Output boundary

Application use-cases are output-agnostic.

Instead of writing directly to `console`, `process.stderr`, or presentation helpers, they publish typed output events through an application-facing output contract.

The CLI layer implements that contract and decides how to render messages and errors. This keeps application logic testable, framework-independent, and stable across future presentation surfaces.

## Port/adapter map

`src/create-app.ts` is the single composition boundary: application use-cases depend on ports, and infrastructure adapters are wired there.

| Port (domain) | Adapter (infrastructure) |
| --- | --- |
| `FileSystem` | `createNodeFileSystem` |
| `ProcessRunner` | `createCrossSpawnProcessRunner` |
| `GitClient` | `createExecFileGitClient` |
| `TemplateLoader` | `createFsTemplateLoader` |
| `VerificationStore` | `createArtifactVerificationStore` |
| `ArtifactStore` | `createFsArtifactStore` |
| `Clock` | `createSystemClock` |
| `SourceResolverPort` | `createSourceResolverAdapter` |
| `TaskSelectorPort` | `createTaskSelectorAdapter` |
| `WorkerExecutorPort` | `createWorkerExecutorAdapter` |
| `TaskVerificationPort` | `createTaskVerificationAdapter` |
| `TaskRepairPort` | `createTaskRepairAdapter` |
| `WorkingDirectoryPort` | `createWorkingDirectoryAdapter` |
| `DirectoryOpenerPort` | `createDirectoryOpenerAdapter` |

## Port-first dependency rule

The dependency direction is strict:

- `src/domain` defines pure logic and contracts.
- `src/application` orchestrates use-cases and depends only on domain contracts (ports).
- `src/infrastructure` implements those ports with side-effecting adapters.
- `src/presentation` renders output and delegates orchestration to application use-cases.

`src/application/*` should not import `src/infrastructure/*` directly. Infrastructure dependencies must flow through injected ports from `createApp(...)`.

## Config directory resolution and fallback

`rundown` resolves the effective configuration directory as `.rundown/`.

Resolution order:

1. If `--config-dir <path>` is provided, that path is used directly (no discovery walk).
2. Otherwise, discovery starts from the command working directory (or source-file directory for source-scoped flows).
3. At each step, check `<current-dir>/.rundown/`; if it exists, stop immediately and use it (the first match wins).
4. If not found, move to the parent directory and repeat.
5. Stop when the filesystem root is reached; if no `.rundown/` was found, discovery returns `undefined`.

When discovery returns `undefined`, behavior is consumer-specific:

- Template consumers (`run`, `discuss`, `plan`, `reverify`) fall back to built-in templates.
- Default vars-file lookup is treated as optional and skipped unless an explicit vars file was requested.
- Runtime artifact and global log writers create `<cwd>/.rundown/` lazily when they need to persist files.
- `init` does not rely on discovery; it creates `.rundown/` in the local working directory unless an explicit config directory is provided.
- Invalid explicit `--config-dir` values are fatal and return a non-zero exit code.

## Lockfile location strategy (decision)

Lockfiles intentionally remain **source-relative**:

- canonical lock path: `<source-dir>/.rundown/<basename>.lock`

Rationale for this decision:

- Lock scope is per Markdown source file, so colocating lock state with that source preserves the scope directly.
- This avoids basename collisions that would occur in a shared `<configDir>/` lock namespace when different directories contain files with the same name.
- It keeps stale-lock recovery predictable (`rundown unlock <source>` always maps to that source's local lock path).

As a result, upward config discovery and `--config-dir` affect templates, vars, runs, and logs, but do **not** relocate per-source lockfiles.

## Run-all commit timing (decision)

`rundown run` keeps `--commit` task-scoped by default. To support "commit once when the file is done" without breaking existing automation, commit timing is an explicit mode choice:

- `--commit-mode per-task|file-done`
- default: `per-task`

Contract:

- `per-task` preserves current behavior: commit after each successful completed task.
- `file-done` applies only to effective run-all flows (`run --all`, `all`, and implicit-all via `--redo` / `--clean`).
- in single-task runs, behavior stays unchanged; `file-done` has no timing effect beyond `per-task` behavior.
- `file-done` performs one deferred commit only after the full run succeeds.
- when `--reset-after` is enabled, reset runs before the deferred final commit.
- deferred final commit runs before source lock release.
- no deferred final commit on early termination (execution failure, verification failure, cancellation, interruption, dry-run).

Multi-round contract (`--rounds > 1`):

- `file-done` produces a single commit after the final successful round, not one commit per round.

Artifact/revert contract for `file-done`:

- the final successful run artifact in that run-all lifecycle records `extra.commitSha`.
- earlier per-task artifacts from that same lifecycle do not backfill `extra.commitSha`.
- revert remains deterministic and run-artifact based, but file-done mode is revertable at run-level (final artifact), not at per-task granularity.

## Sources

`rundown` can scan:

- a single Markdown file,
- a directory,
- or a glob such as `notes/**/*.md`.

Supported task forms include:

- `- [ ] task`
- `* [ ] task`
- `+ [ ] task`

Nested tasks are supported.

When tasks are listed, `rundown` shows nested structure explicitly:

- nested checkbox items are rendered as child tasks under their parent,
- and nested plain list bullets (non-checkbox items) are rendered as sub-items under that parent.

## Task selection

Task selection is deterministic:

1. resolve the source into Markdown files,
2. sort those files,
3. scan each file in document order,
4. pick the first runnable unchecked task.

A task is runnable only when it has **no unchecked descendants**.

That means child tasks always run before their parent. This is what makes planning safe: once a task is decomposed into subtasks, the parent is blocked until those subtasks are completed.

Nested checkbox contract:

- A parent checkbox is treated as a separate task.
- A parent task does not run until every descendant task is checked.
- Child tasks therefore execute before the parent.
- If you want a heading that only groups items, use a plain list bullet without a checkbox.

Those plain list bullets are informational only: they are visible in list output as sub-items, but they are not treated as runnable tasks.

## Sorting

Default sorting is `name-sort`, a human-friendly natural sort that works well for filenames such as:

- `01. Idea.md`
- `02. Plan.md`
- `10. Ship.md`

Other modes:

- `none`
- `old-first`
- `new-first`

Inside each file, tasks are always scanned from top to bottom.

## Two task types

### Agent tasks

A normal Markdown task is rendered into a prompt and sent to the configured worker command.

Example:

```md
- [ ] Rewrite the opening section so the README is clearer and more confident
```

### Inline CLI tasks

A task beginning with `cli:` is executed directly by `rundown`.

The working directory is the directory containing the Markdown file.

Example:

```md
- [ ] cli: npm test
- [ ] cli: node scripts/build-index.js
```

If a CLI command is written in a saved Markdown file, `rundown` treats that as explicit permission to run it.

## Unified tool prefixes

Most checkbox prefixes resolve through a unified tool pipeline.

Form:

```md
- [ ] <tool-name>: <payload>
```

Built-in handler aliases:

- verify-only: `verify:`, `confirm:`, `check:`
- memory capture: `memory:`, `memorize:`, `remember:`, `inventory:`
- fast execution (skip verification): `fast:`, `raw:`
- end control flow (skip remaining siblings when condition is true): `end:`, `return:`, `skip:`, `quit:`, `break:`
- file composition: `include:`

Decision: `return:`, `skip:`, `quit:`, and `break:` are aliases of `end:` in v1.
All four prefixes resolve to the same control-flow handler and share identical semantics.

Built-in modifier:

- `profile=`

Modifier and handler composition:

- `profile=fast, verify: tests pass`
- `profile=complex; memory: capture design tradeoffs`
- `fast: ship release notes without verification`

Intent precedence notes:

- `fast:` / `raw:` are per-task aliases that disable verification for that task (inverse of `verify:`).
- `fast:` / `raw:` support directive-parent inheritance (`- fast:` / `- raw:`) for child checkboxes.
- Mixed explicit intent prefixes follow first-prefix precedence (`verify: fast: ...` -> verify-only, `fast: verify: ...` -> fast-execution).

Modifiers patch context left-to-right; the terminal handler executes behavior. If only modifiers are present, rundown uses default execute+verify with the modified context.

Special-case forms:

- `cli:` and `rundown:` remain parser-level task forms and do not run through tool resolution.

## Runner modes

Runner mode controls how the selected task is handed off.

### `wait`

Start the worker and wait for completion.

This is the default and the strongest mode for verification and repair.

### `tui`

Start an interactive terminal session, let the user steer it, then continue verification after exit.

This works well with tools such as `opencode`.

### `detached`

Start the worker without waiting.

This mode keeps runtime artifacts on disk, skips immediate verification, and leaves the task unchecked.

## Prompt transport

Rendered prompts can be delivered in two ways.

### `file`

Write the rendered prompt to a Markdown file under `.rundown/runs/` and pass that file to the worker.

This is the default because it is robust, especially on Windows where large prompts and shell quoting are fragile.

### `arg`

Pass the prompt directly as command arguments.

This can be useful for smaller prompts, but it is less reliable for large Markdown context.

## Runtime artifacts

Each real `run` or `plan` execution can create a per-run folder under `.rundown/runs/`.

Typical contents include:

- `run.json`
- phase folders such as `01-execute/`, `02-verify/`, `03-repair/`
- `prompt.md`
- `stdout.log`
- `stderr.log`
- `metadata.json`

Artifacts are cleaned up by default after a successful normal run.

Use `--keep-artifacts` to preserve them.

Detached mode always keeps them.

## Validation and repair

Verification is a separate phase from execution.

After execution, `rundown` renders the verify template, runs the verifier, and persists the parsed verification result in verify-phase runtime artifacts (stored in phase metadata alongside stdout/stderr logs).

Verifier contract:

- `OK` means complete.
- Any other stdout text is treated as a failure reason.

If the persisted verification result contains exactly `OK`, the task is considered complete.

Anything else means the task stays unchecked.

When repair runs, `{{verificationResult}}` is sourced from the latest verify-phase artifact metadata for that task.

If verification fails and repair attempts are enabled, `rundown` renders the repair template, runs another pass, and verifies again.

## Reverify historical tasks

`rundown reverify` re-runs verify/repair for a previously completed task from saved artifacts.

Reverify is read-only with respect to task source Markdown: it does not check tasks, uncheck tasks, or rewrite source files. For that reason it does not acquire the exclusive lock used by mutating commands such as `run` and `plan`.

Unlike `run --only-verify`, it does not select a new unchecked task and does not mutate Markdown checkbox state. This makes it suitable for deterministic confidence checks before release or push.

Task resolution from saved metadata is explicit and ordered:

1. exact match by `line + text`,
2. fallback to `index + text`,
3. fallback to a unique `text` match.

If no unique match is found, `reverify` exits with code `3` and leaves Markdown unchanged.

### Residual edge cases

- Heavily edited files can invalidate historical metadata (for example, task text rewritten, duplicates introduced, or source file moved/removed).
- Ambiguous text-only matches intentionally fail instead of guessing.
- Runs missing `run.json` or task metadata are rejected with actionable guidance.

### Follow-up work

- Store stronger stable task identity in artifacts (for example, structural hash or parent-heading fingerprint) to improve recovery after major edits.
- Add optional "strict" vs "relaxed" resolution modes so CI can enforce exact matching while local flows can opt into broader recovery.
- Explore a "task moved" helper that prints likely candidate matches when deterministic resolution fails.

## Revert completed tasks

`rundown revert` undoes previously completed tasks by applying git history changes from commit metadata stored in saved run artifacts.

This command only works for runs that were completed with both:

- `--commit` (so the run lifecycle recorded a commit SHA), and
- `--keep-artifacts` (so `run.json` and `extra.commitSha` are still available).

Revert granularity follows commit timing:

- `--commit-mode per-task` records one commit per successful task, so each completed task run can be reverted independently.
- `--commit-mode file-done` (effective run-all only) records one commit at full run completion, so revert is available at run-level for that final artifact rather than per intermediate task.

Target selection mirrors the historical-run pattern used by `reverify`:

- revert one run (`--run <id|latest>`),
- revert the last `N` runs (`--last <n>`), or
- revert all revertable runs (`--all`).

Two git strategies are supported:

- `revert` (default): creates inverse commits (`git revert <sha> --no-edit`) and is safe for shared branches.
- `reset`: rewinds history with `git reset --hard <oldest-sha>~1`, but only when targets form a contiguous block at `HEAD`.

When `reset` executes, the revert artifact stores the pre-reset `HEAD` as `extra.preResetRef`. That makes reset-based undos reversible: you can later run `rundown revert --run <revert-run-id> --method reset` to jump back to the saved ref.

For multi-run revert, processing order is deliberate:

- `revert` runs newest-first to reduce patch conflicts.
- `reset` validates a contiguous `HEAD` block, then resets once before the oldest target commit.

Reset-based revert runs are restored one at a time (single `--run`) because each one captures its own pre-reset reference.

Markdown checkboxes are restored by git history itself. `rundown` does not directly mutate checkbox state during `revert`.

Use `--dry-run` to preview selected runs, SHAs, and undo method without changing repository state.

Use `--force` to bypass clean-worktree and reset contiguous-HEAD checks. This is intentionally unsafe and should be reserved for advanced recovery workflows.

## Research before planning

Use `rundown research` when a feature document is too thin for high-quality TODO synthesis.

`research` reads the full Markdown file and rewrites the document body with richer context: expanded intent, implementation constraints, integration notes, and planning scaffolding.

Guardrails:

- `research` must preserve existing checkbox states.
- `research` must not introduce new unchecked TODO items.
- output is applied as full-document replacement and rolled back on guard violations.

Typical flow:

1. `rundown research <source> -- opencode run`
2. `rundown plan <source> --scan-count 3 -- opencode run`
3. `rundown run <source> -- opencode run`

## Planning

`rundown plan` expands a selected task into nested subtasks.

The planner worker should return only unchecked Markdown task items. Those items are inserted directly beneath the parent task at one indentation level deeper.

After planning, the parent task becomes blocked until its new children are complete.

## Discuss before execution

Use `rundown discuss` when the next unchecked task is unclear, too broad, or needs to be reshaped before implementation.

The discuss command uses the same task-selection flow as `run`, but opens an interactive session where the agent can edit the source Markdown task text (for example: rewrite, split into subtasks, or tighten scope).

Typical workflow:

1. `rundown discuss <source> -- opencode`
2. refine the selected task until it is actionable,
3. `rundown run <source> -- opencode run` to execute,
4. let verification confirm the result before the checkbox is marked complete.

Discussion does not mark tasks complete by itself. Completion remains gated by `run` + verification.

## Why this model matters

Many AI workflows still depend on copy-paste handoffs and human memory.

`rundown` replaces that with a visible, file-based loop:

- Markdown provides the intent,
- templates provide the instructions,
- workers provide execution,
- verification provides trust,
- and checkbox updates become evidence rather than optimism.
