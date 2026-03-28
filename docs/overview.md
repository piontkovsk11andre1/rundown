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
| `VerificationSidecar` | `createFsVerificationSidecar` |
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

After execution, `rundown` renders the verify template, runs the verifier, and persists verifier stdout to a task-specific sidecar file next to the source document, for example:

```text
Tasks.md.3.validation
```

Verifier contract:

- `OK` means complete.
- Any other stdout text is treated as a failure reason.

If the sidecar file contains exactly `OK`, the task is considered complete.

Anything else means the task stays unchecked.

If verification fails and repair attempts are enabled, `rundown` renders the repair template, runs another pass, and verifies again.

## Reverify historical tasks

`rundown reverify` re-runs verify/repair for a previously completed task from saved artifacts.

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

- `--commit` (so a task-specific commit exists), and
- `--keep-artifacts` (so `run.json` and `extra.commitSha` are still available).

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

## Planning

`rundown plan` expands a selected task into nested subtasks.

The planner worker should return only unchecked Markdown task items. Those items are inserted directly beneath the parent task at one indentation level deeper.

After planning, the parent task becomes blocked until its new children are complete.

## Why this model matters

Many AI workflows still depend on copy-paste handoffs and human memory.

`rundown` replaces that with a visible, file-based loop:

- Markdown provides the intent,
- templates provide the instructions,
- workers provide execution,
- verification provides trust,
- and checkbox updates become evidence rather than optimism.
