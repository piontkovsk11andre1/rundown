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

- `start` is path-first onboarding: `rundown start`, `rundown start <design-dir>`, or `rundown start <design-dir> <workdir>` (directory-only; non-empty local design dirs require explicit outer workdir, for example `rundown start . ..\\myproject-rundown`).
- `design/current/` remains the mutable draft workspace.
- `migrate` is the canonical migration-authoring command and supports explicit source reconciliation modes: default design-diff (`rundown migrate`), implementation (`rundown migrate --from implementation`), and prediction (`rundown migrate --from prediction`).
- In default mode, `migrate` performs a preflight revision sync: when `design/current/` differs from the latest released snapshot (or no release exists yet), it writes the next immutable `design/revisions/rev.N/` revision before planning.
- Revision baseline semantics are explicit: `rev.0` is the initial baseline when present, and when a target revision has no discovered lower predecessor (including `rev.1`-first repositories), comparison is from `nothing -> target`.
- Compatibility fallback remains additive for older projects: legacy `design/rev.*/`, `docs/current/Design.md`, `docs/rev.*/`, and root `Design.md` are used only as compatibility-only paths when canonical `design/` paths are unavailable.
- `migrate` always routes through the same revision-aware/thread-aware migration drafting pipeline and writes migration history in `migrations/`.
- `predict` applies migration files into `prediction/latest/` incrementally and writes full-tree lane snapshots under `prediction/snapshots/root/<N>/` and `prediction/snapshots/threads/<thread>/<N>/` after successful lane-boundary passes.
- `snapshot` records implementation history directly from the live `implementation/` tree into `implementation/snapshots/root/<N>/` and `implementation/snapshots/threads/<thread>/<N>/`, where `N` is inferred from each lane's highest fully completed migration batch.
- `snapshot` is boundary-gated: it fails explicitly (without writing snapshots) when any lane is between migrations, and it treats existing lane/number snapshots as already-recorded history rather than overwrite targets.
- `undo` semantically reverses prior task outcomes using saved artifacts.
- `test now` verifies assertion specs against current implementation/materialized state.
- `test future` verifies assertion specs against prediction state.

Prediction migration naming convention:

- migration step: `7. Implement Feature.md`
- satellite artifact: `7.1 Snapshot.md`

Snapshot checkpoints use dotted numeric suffix `N.1` on the same migration number.
Backlog is a singleton file: `migrations/Backlog.md`.

Migration authoring loop model:

1. Edit `design/current/**`.
2. Run one of:
   - `rundown migrate` (design-diff default),
   - `rundown migrate --from implementation`,
   - `rundown migrate --from prediction`.
3. The selected mode reconciles/release-updates design as needed, then runs the same migrate planner loop until `DONE`.
4. Discuss and refine predicted state, including updates to `migrations/Backlog.md` as needed.
5. Optionally revise source-of-truth content and run `rundown migrate ...` again.
6. Run `rundown predict` to apply migration files into `prediction/latest/` and persist lane snapshots under `prediction/snapshots/`.
7. Run `rundown materialize` to apply resulting state into `implementation/`.
8. Run `rundown snapshot` to persist implementation filesystem history at the current completed migration boundaries.

Explicit test target semantics:

- `rundown test now` validates implementation/materialized state.
- `rundown test future` validates prediction state.
- `rundown test new <assertion>` creates a new assertion spec.
- `rundown test` remains a compatibility alias for `rundown test now`.

## Output boundary

Application use-cases are output-agnostic.

Instead of writing directly to `console`, `process.stderr`, or presentation helpers, they publish typed output events through an application-facing output contract.

The CLI layer implements that contract and decides how to render messages and errors. This keeps application logic testable, framework-independent, and stable across future presentation surfaces.

## Port/adapter map

`src/create-app.ts` is the single composition boundary: application use-cases depend on ports, and infrastructure adapters are wired there.

| Port (domain) | Adapter (infrastructure) |
| --- | --- |
| `FileSystem` | `createNodeFileSystem` |
| `FileLock` | `createFsFileLock` |
| `ConfigDirPort` | `createConfigDirAdapter` |
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
| `PathOperationsPort` | `createNodePathOperationsAdapter` |
| `MemoryResolverPort` | `createMemoryResolverAdapter` |
| `MemoryReaderPort` | `createMemoryReaderAdapter` |
| `MemoryWriterPort` | `createMemoryWriterAdapter` |
| `ToolResolverPort` | `createToolResolverAdapter` |
| `InteractiveInputPort` | `createTerminalInteractiveInputAdapter` |
| `WorkerConfigPort` | `createWorkerConfigAdapter` |
| `WorkerHealthStore` | `createFsWorkerHealthStore` |
| `TemplateVarsLoaderPort` | `createFsTemplateVarsLoaderAdapter` |
| `TraceWriterPort` | `createNoopTraceWriter` |
| `CommandExecutor` | `createCliBlockExecutor` |
| `ApplicationOutputPort` | `createNoopOutputPort` |

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

## Harness presets

Use `rundown with <harness>` to quickly configure runnable worker defaults from a known harness preset.

See the command-focused reference: [cli-with.md](cli-with.md).

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
- fast execution (skip verification): `fast:`, `raw:`, `quick:`
- conditional sibling skip (when condition is true): `optional:`, `skip:`
- terminal stop control: `quit:`, `exit:`, `end:`, `break:`, `return:`
- file composition: `include:`
- outer retry wrapper: `force:`

Decision: `optional:` is canonical in v1, with `skip:` as the preferred concise alias for sibling short-circuit behavior.
`quit:` / `exit:` / `end:` / `break:` / `return:` are terminal-control aliases with graceful stop semantics.
`optional:`/`skip:` behavior remains unchanged and independent from terminal stop behavior.

Control semantics split:

- `optional:` / `skip:` evaluate a yes/no condition and only short-circuit remaining siblings in the same parent scope when true.
- `quit:` / `exit:` / `end:` / `break:` / `return:` are run-stop signals. Empty payload is allowed and means unconditional stop. Non-empty payload is evaluated as yes/no and stops only on `true`.
- In normal `run` flow, terminal stop prevents scheduling any remaining work after the current task lifecycle finalizes.
- In `loop` flow, terminal stop exits the outer loop immediately after the current iteration finalizes.

Built-in modifier:

- `profile=`

Modifier and handler composition:

- `profile=fast, verify: tests pass`
- `profile=complex; memory: capture design tradeoffs`
- `fast: ship release notes without verification`

Intent precedence notes:

- `fast:` / `raw:` / `quick:` are per-task aliases that disable verification for that task (inverse of `verify:`).
- `fast:` / `raw:` / `quick:` support directive-parent inheritance (`- fast:` / `- raw:` / `- quick:`) for child checkboxes.
- Mixed explicit intent prefixes follow first-prefix precedence (`verify: fast: ...` -> verify-only, `fast: verify: ...` -> fast-execution).

Memory-capture contract:

- Persisted source-local memory artifacts are authoritative (`.rundown/<source>.memory.md` and `.rundown/memory-index.json`).
- `memory-result:` inline bullets are legacy/non-authoritative and are not emitted as part of `memory:` execution.
- Rundown owns `memory:` checkbox completion after execute persistence and verification; workers should not manually check the task or inject ad hoc source-note annotations.

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

Write the rendered prompt to a Markdown file under `<config-dir>/runs/` and pass that file to the worker.

This is the default because it is robust, especially on Windows where large prompts and shell quoting are fragile.

### `arg`

Pass the prompt directly as command arguments.

This can be useful for smaller prompts, but it is less reliable for large Markdown context.

## Runtime artifacts

Each real `run` or `plan` execution can create a per-run folder under `<config-dir>/runs/`.

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

Worker routing across verify/repair lifecycle is phase-aware:

- verify, repair, resolve, and resolve-informed repair can each resolve a different worker via `run.workerRouting`.
- attempt-aware selectors allow escalation by attempt number (for example, stronger worker at later repair attempts).

Health failover and semantic escalation are separate mechanisms:

- inherited worker routes continue to use technical failover from `workers.fallbacks`.
- explicit phase routes are deterministic and do not use `workers.fallbacks` unless `useFallbacks: true` is set.

When `run.workerRouting.reset` is configured, rundown can do one semantic reset retry after verify/repair exhaustion:

- restore git state for the failed cycle,
- retry using the dedicated reset worker route,
- keep this semantic retry independent from health-failover budgets.

Semantic reset is opt-in and artifact-backed. If required run metadata or git commit context is unavailable, rundown fails with guidance rather than attempting unsafe history reconstruction.

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

## Revert completed tasks

`rundown revert` undoes previously completed materialized implementation state by restoring implementation snapshots recorded in saved run artifacts.

This command only works for runs that:

- completed successfully,
- include snapshot restore metadata (`extra.implementationSnapshotTargets`), and
- still reference at least one existing snapshot payload on disk.

Snapshot-based revert history is independent from git commit requirements and does not require clean-worktree checks.

Revert granularity follows snapshot boundaries:

- snapshot numbering is tied to completed migration boundaries per lane,
- and revert restores implementation state at those recorded boundaries.

Target selection mirrors the historical-run pattern used by `reverify`:

- revert one run (`--run <id|latest>`),
- revert the last `N` runs (`--last <n>`), or
- revert all revertable runs (`--all`).

Two method values are accepted:

- `revert` (default): performs snapshot restore.
- `reset`: compatibility alias for the same snapshot restore behavior.

For multi-run revert, processing order is deliberate:

- snapshot restores run newest-first to preserve expected rollback ordering.

`revert` restores the live `implementation/` tree from snapshot payloads and does not rewrite git history.

Use `--dry-run` to preview selected runs and snapshot targets without changing implementation state.

`--force` is accepted for compatibility but ignored by snapshot restore.

## Research before planning

Use `rundown research` when a feature document is too thin for high-quality TODO synthesis.

`research` reads the full Markdown file and rewrites the document body with richer context: expanded intent, implementation constraints, integration notes, and planning scaffolding.

Guardrails:

- `research` must preserve existing checkbox states.
- `research` must not introduce new unchecked TODO items.
- output is applied as full-document replacement and rolled back on guard violations.

Typical flow:

1. `rundown research <source> -- opencode run`
2. `rundown plan <source> -- opencode run`
3. `rundown run <source> -- opencode run`

## Planning

`rundown plan` expands a selected task into nested subtasks.

The planner worker should return only unchecked Markdown task items. Those items are inserted directly beneath the parent task at one indentation level deeper.

After planning, the parent task becomes blocked until its new children are complete.

## Discuss before execution

Use `rundown discuss <file.md>` when a file's pending work is unclear, too broad, or needs to be reshaped before implementation.

The discuss command is file-oriented: it opens an interactive session over the selected file, includes the current source snapshot, and surfaces one related-artifacts list for that file. It does not require preselecting a run.

Typical workflow:

1. `rundown discuss roadmap.md -- opencode`
2. refine file tasks until they are actionable,
3. `rundown run roadmap.md -- opencode run` to execute,
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
