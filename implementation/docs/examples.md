# Examples

## 1. Execute the next documentation task with OpenCode

Markdown:

```md
# Docs backlog

- [x] Clean up the release checklist
- [ ] Rewrite the opening paragraph for the README
- [ ] Add shell-specific install notes
```

Command:

```bash
rundown run docs/backlog.md -- opencode run
```

What happens:

1. `rundown` selects `Rewrite the opening paragraph for the README`
2. renders the execute prompt from Markdown context,
3. runs `opencode run`,
4. verifies the result,
5. runs repair attempts if configured,
6. and only then marks the task complete.

## 2. One-command OpenCode onboarding with `with`

```bash
rundown with opencode
```

What this configures:

1. `workers.default` for deterministic execution (`opencode run $bootstrap`),
2. `workers.tui` for interactive TUI sessions (`opencode --prompt $bootstrap`) and `commands.discuss` for direct discuss sessions (`opencode`),
3. while preserving unrelated `.rundown/config.json` keys.

What happens right after configuration:

1. In interactive terminals, `rundown with opencode` immediately opens the Rundown root TUI.
2. If stdin/stdout is non-interactive (for example CI), it prints config results and exits without launching TUI.

Overwrite safety behavior:

1. If local worker keys already exist and `with opencode` would replace or update them, rundown asks for confirmation first.
2. If you decline, no config is changed.
3. In non-interactive execution, rundown fails with guidance instead of silently overwriting existing worker settings.

Persisted local config fragment:

```json
{
  "workers": {
    "default": ["opencode", "run", "$bootstrap"],
    "tui": ["opencode", "--prompt", "$bootstrap"]
  },
  "commands": {
    "discuss": ["opencode"]
  }
}
```

Alias inputs such as `rundown with OpenCode` and `rundown with open-code` normalize to the same canonical `opencode` persistence.

OpenCode behavior after this setup:

1. Deterministic commands (`run`, `plan`, `research`, `reverify`) resolve to `opencode run` via `workers.default`.
2. Interactive discussion (`discuss`) resolves to `opencode` via `commands.discuss`, while TUI mode uses `workers.tui`.

After this, worker flags are optional for standard OpenCode usage:

```bash
rundown run roadmap.md
rundown discuss roadmap.md
```

## 3. PowerShell-safe worker usage

```powershell
rundown run docs/ --worker 'opencode run --file $file $bootstrap'
```

This form avoids common PowerShell argument-splitting friction around `--`.

## 4. Interactive TUI handoff

```bash
rundown run roadmap.md --mode tui -- opencode
```

This opens the interactive session, lets the user steer it, then returns to `rundown` for verification and optional repair after exit.

## 5. Inline CLI task

Markdown:

```md
- [ ] cli: npm test
```

Command:

```bash
rundown run . -- opencode run
```

Because the task starts with `cli:`, `rundown` executes `npm test` directly instead of sending the task to the worker.

## 6. Plan first, execute later

Markdown:

```md
- [ ] Refresh the README for the release candidate
```

Planning command:

```bash
rundown plan README.md -- opencode run
```

Possible planner output:

```md
- [ ] Rewrite the opening value proposition
- [ ] Add a sharper quick-start example
- [ ] Move detailed behavior into docs/
```

Those items are inserted as nested subtasks. Because child tasks must complete before the parent, the new subitems become the next runnable work.

## 7. Research before planning

Use `research` when a document is still thin and needs implementation context before TODO synthesis.

```bash
rundown research docs/release-plan.md -- opencode run
rundown plan docs/release-plan.md -- opencode run
```

What happens:

1. `research` rewrites the document body with richer context and structure,
2. preserves existing author intent and checkbox state,
3. rejects output that introduces new unchecked TODO items,
4. then `plan` appends actionable TODOs from that enriched foundation.

## 8. Variables for repository context

```bash
rundown run roadmap.md --vars-file --var ticket=ENG-42 -- opencode run
```

This loads `.rundown/vars.json`, overrides `ticket`, and makes those values available in templates.

## 9. Keep artifacts for inspection

```bash
rundown run roadmap.md --keep-artifacts -- opencode run
```

This preserves the per-run folder under `<config-dir>/runs/` so prompts, logs, and metadata can be inspected later.

## 10. Auto-commit completed tasks

```bash
rundown run docs/ --commit -- opencode run
```

After a task is verified and checked, `rundown` stages the Markdown file and commits with a structured message:

```
rundown: complete "Add installation notes" in docs/setup.md
```

To find when a specific task was completed:

```bash
git log --grep='rundown: complete' --oneline
```

Custom commit messages:

```bash
rundown run docs/ --commit --commit-message "rundown: complete \"{{task}}\" in {{file}}" -- opencode run
```

Run all tasks and commit once at file completion:

```bash
rundown run docs/ --all --commit --commit-mode file-done -- opencode run
```

Run all tasks and keep one commit per completed task:

```bash
rundown run docs/ --all --commit --commit-mode per-task -- opencode run
```

`per-task` remains the default commit mode; pass it explicitly in automation when you want that behavior to be stable and obvious.

## 11. Post-completion hooks

Run any command after a task completes. Task metadata is available as environment variables.

```bash
rundown run roadmap.md --on-complete "git push" -- opencode run
```

Combine with `--commit` for a full auto-commit-and-push flow:

```bash
rundown run roadmap.md --commit --on-complete "git push" -- opencode run
```

Or use the hook for notifications, logging, or chaining:

```bash
rundown run roadmap.md --on-complete 'echo "Completed: $RUNDOWN_TASK in $RUNDOWN_FILE"' -- opencode run
```

## 12. A practical OpenCode setup

A clean default pattern is:

- `rundown run roadmap.md -- opencode run`
- `rundown run roadmap.md --mode tui -- opencode`

This keeps prompt handoff durable, inspectable, and friendly to large Markdown context.

## 13. Reverify before release

```bash
rundown reverify --no-repair -- opencode run
```

Use this to re-check the latest completed task with the current verify template before a push or release cut. The command exits non-zero on verification failure and does not modify Markdown checkbox states.

If historical metadata no longer maps to a unique task after major edits, `reverify` exits with code `3` instead of guessing.

## 14. Revert a previously completed task

```bash
rundown revert --run latest
```

`revert` requires the original run to be completed with implementation snapshot metadata and a snapshot payload still present on disk.

Revert restores the live `implementation/` tree from the selected snapshot target rather than replaying git commit history.

## 15. Concurrent run protection on one source file

Terminal A:

```bash
rundown run roadmap.md -- opencode run
```

Terminal B (same source while Terminal A still runs):

```bash
rundown run roadmap.md -- opencode run
```

The second command fails fast because `roadmap.md` is already locked by the first process. Use this behavior to prevent overlapping read/write cycles against the same task file.

If you target a different source file, both runs can proceed concurrently:

```bash
rundown run roadmap.md -- opencode run
rundown run docs/setup.md -- opencode run
```

## 16. Recover from stale locks

If a previous process crashed and left a stale lockfile, remove it manually:

For `roadmap.md`, the stale lock path is `<source-dir>/.rundown/<basename>.lock` (for example, `.rundown/roadmap.lock` in the source directory).

```bash
rundown unlock roadmap.md
```

Or let `run`/`plan` clear stale locks before acquiring their own lock:

```bash
rundown run roadmap.md --force-unlock -- opencode run
rundown plan roadmap.md --force-unlock -- opencode run
```

`--force-unlock` and `unlock` only remove stale locks. They do not break locks held by a live process.

## 17. Mixed TODO with `cli:` and `rundown:` tasks

Markdown:

```md
# Release prep

- [ ] cli: npm test
- [ ] rundown: docs/release-notes.md --verify --repair-attempts 1
- [ ] Publish release notes
```

Command:

```bash
rundown run TODO.md --worker 'opencode run --file $file $bootstrap' --verify --repair-attempts 2
```

What happens:

1. `rundown` executes `npm test` directly for the `cli:` task.
2. For the `rundown:` task, it delegates to `rundown run docs/release-notes.md --verify --repair-attempts 1`.
3. The inline `rundown:` flags override forwarded parent flags when they differ.
4. After the delegated run succeeds, the parent run verifies/checks that task and continues.

Note: legacy `--retries <n>` is still accepted as an alias for `--repair-attempts <n>`, but docs use `--repair-attempts` as the primary flag.

## 18. Layered worker profiles from config

Fresh `rundown init` writes `.rundown/config.json` as `{}`. With that empty default, pass a worker explicitly (`--worker ...` or `-- ...`) until you configure one.

Example `.rundown/config.json`:

```json
{
  "workers": {
    "default": ["opencode", "run", "--file", "$file", "$bootstrap"],
    "tui": ["opencode"]
  },
  "commands": {
    "plan": ["opencode", "run", "--file", "$file", "$bootstrap", "--model", "opus-4.6"]
  },
  "profiles": {
    "fast": ["opencode", "run", "--file", "$file", "$bootstrap", "--model", "gpt-5.3-codex"],
    "complex": ["opencode", "run", "--file", "$file", "$bootstrap", "--model", "opus-4.6"]
  }
}
```

With this config, commands can run without passing `--worker` every time:

```bash
rundown run TODO.md
rundown plan TODO.md
```

Markdown with file-level and directive-parent profiles:

```md
---
profile: complex
---

- [ ] Draft migration plan

- profile=fast
  - [ ] Fix typo in release notes
  - [ ] Update one CLI flag example

- check:
  - [ ] All tests pass
  - [ ] Linting clean
```

How model selection resolves:

1. `Draft migration plan` inherits frontmatter `complex` and runs with `--model opus-4.6`.
2. Tasks under `- profile=fast` override frontmatter and run with `--model gpt-5.3-codex`.
3. Tasks under `- check:` are verify-only tasks.
4. A CLI worker still overrides all config/profile layers when provided.

## 19. Command-output blocks (`cli` fenced blocks)

Use fenced `cli` blocks in Markdown or templates when you want `rundown` to execute commands and inject their output into the worker prompt.

Cat a file for context:

```md
- [ ] Investigate failing test

  ```cli
  cat src/auth/token.ts
  ```
```

Query a database for live context:

```md
- [ ] Verify user seed data looks correct

  ```cli
  sql -m "SELECT id, email, created_at FROM users ORDER BY id DESC LIMIT 5"
  ```
```

Run a linter and include diagnostics in the prompt:

```md
- [ ] Fix lint issues in API handlers

  ```cli
  npm run lint -- src/api
  ```
```

Run command:

```bash
rundown run TODO.md -- opencode run
```

Useful flags:

- `--ignore-cli-block` keeps `cli` blocks unexpanded (safe for review and dry inspection).
- `--cli-block-timeout 60000` increases command timeout to 60 seconds.

## 20. Unified prefix composition

Markdown:

```md
- [ ] verify: release checklist is complete
- [ ] fast: regenerate release notes snippets
- [ ] profile=fast, verify: docs examples are accurate
- [ ] profile=complex; memory: capture migration assumptions
- [ ] include: ./release-subtasks.md
```

What happens:

1. `verify:` / `confirm:` / `check:` run verify-only behavior.
2. `memory:` / `memorize:` / `remember:` / `inventory:` run capture + persist, then verify; persisted memory artifacts are canonical and inline `memory-result:` annotations are not emitted.
3. `fast:` / `raw:` / `quick:` run execution without verification for that task (inverse of verify-only).
4. `profile=` applies as a modifier and composes with downstream handler tools.
5. `include:` executes tasks from a cloned artifacts copy of the target markdown file and auto-checks include on success.
6. When mixed explicit intent prefixes appear in task text, the first explicit prefix wins (`verify: fast: ...` is verify-only; `fast: verify: ...` is fast-execution).
7. `optional:` / `skip:` are conditional sibling-skip prefixes; `quit:` / `exit:` / `end:` / `break:` / `return:` are terminal stop-control prefixes.
8. Unknown prefixes are treated as normal task text and do not fail resolution.

Terminal-stop examples:

```md
- [ ] exit:
- [ ] return: release branch already merged
- [ ] optional: docs already published
```

- `exit:` stops unconditionally.
- `return: ...` stops only when the condition evaluates true.
- `optional: ...` keeps sibling-skip behavior only; it does not stop full run/loop.

## 21. Source-aware migrate modes

Use `rundown migrate` as the canonical revision-aware workflow.

```bash
# Default mode: design-diff migration authoring.
rundown migrate --dir ./migrations -- opencode run

# Reconcile current design from implementation changes, then create migrations.
rundown migrate --from implementation --dir ./migrations -- opencode run

# Reconcile current design from prediction changes, then create migrations.
rundown migrate --from prediction --dir ./migrations -- opencode run

# Design-less file-input mode: plan directly from one source file.
rundown migrate --from-file ./design/Plan.md --dir ./migrations -- opencode run

# When workspace.link has multiple records, select explicitly.
rundown migrate --dir ./migrations --workspace ../source-workspace -- opencode run
```

What happens:

1. `rundown migrate` remains a single canonical command (no positional migrate actions).
2. With no `--from`, migrate runs the default design-diff flow.
3. `--from implementation` and `--from prediction` run source-specific reconciliation first, then hand off to the same revision-aware planner/drafter pipeline.
4. If reconciliation or preflight yields no effective design boundary change, migrate exits with a caught-up/no-op result.
5. Planning still targets released revision metadata boundaries (`plannedAt`, `migrations`).
6. Legacy flat `design/rev.*/`, `docs/current/Design.md`, and `docs/rev.*/` layouts remain readable only as compatibility-only fallback sources.
7. `--from-file` uses the explicit file as planning source and does not require `design/current/` or released revisions.
8. If thread briefs exist under `.rundown/threads/*.md`, `--from-file` still runs thread-aware drafting/promotion.

If linked workspace resolution is ambiguous (for example `.rundown/workspace.link` has multiple records and no default), path-sensitive commands such as `migrate` fail with candidate guidance and require `--workspace <dir>`.

`--from-file` and `--from` are mutually exclusive; pass only one planning source mode.

## 22. Quick migration file creation with `migrate new`

```bash
# Create exactly one next-numbered canonical migration in the selected scope.
rundown migrate new "File name basically" --dir ./migrations
```

What happens:

1. Rundown computes the next number for the target migration scope (`--dir`).
2. It creates a single canonical filename like `132. File name basically.md`.
3. It exits immediately without planning/revision/prediction/materialization side effects.

This shortcut is useful when you want to author a migration manually, then continue with `predict`/`materialize` later.

## 23. Mounted routing examples (local, linked, bare control)

Path-first onboarding safety reminder:

- Use `rundown start` for greenfield empty directories.
- If the local design directory is non-empty, provide an explicit outer workdir (for example, `rundown start . ../control`).

Local default workspace (no link, single root):

```text
invocationDir=/repo
workspaceDir=/repo
workspaceDesignPath=/repo/design
workspaceImplementationPath=/repo/implementation
workspaceSpecsPath=/repo/specs
workspaceMigrationsPath=/repo/migrations
workspacePredictionPath=/repo/prediction
```

Linked workspace (control workspace differs from invocation directory):

```text
invocationDir=/work/client-a
workspaceDir=/work/platform-core
isLinkedWorkspace=true
workspaceDesignPath=/work/platform-core/design
workspaceImplementationPath=/work/platform-core/implementation
workspaceSpecsPath=/work/client-a/specs
workspaceMigrationsPath=/work/platform-core/migrations
workspacePredictionPath=/work/platform-core/prediction
```

Bare control workspace with mounted content:

```bash
rundown start . ../control --mount design=../docs/design --mount implementation=. --mount specs=../qa/specs --mount migrations=../control/migrations --mount prediction=../control/prediction -- opencode run
```

Resulting routing shape:

```text
workspaceDir=/work/control
workspaceDesignPath=/work/docs/design
workspaceImplementationPath=/work/app
workspaceSpecsPath=/work/qa/specs
workspaceMigrationsPath=/work/control/migrations
workspacePredictionPath=/work/control/prediction
```

Nested mount override example:

```bash
rundown start . ../control --mount implementation=. --mount implementation/generated=./generated -- opencode run
```

Runtime prompt contract for these scenarios:

1. `workspace*Path` values are already resolved absolute targets and are authoritative.
2. Do not recompute paths from `workspaceDir` and logical directory names.
3. When present, `workspaceMountSummary` is the canonical logical-path routing map.

## 24. Predict then test target states explicitly

Use this command family to keep planning, future-state projection, and implementation application separate:

```bash
# 1) Create or update migrations from design changes.
rundown migrate --dir ./migrations -- opencode run

# 2) Apply migration files into prediction/latest/ and persist lane snapshots.
rundown predict --dir ./migrations -- opencode run

# 3) Validate the future state in prediction/latest/.
rundown test future

# 4) Apply resulting state to implementation/.
rundown materialize --dir ./migrations -- opencode run

# 5) Validate the current implementation state.
rundown test now
```

What this demonstrates:

1. `migrate` is the producer of migration files.
2. `predict` is the migration-file consumer that advances only `prediction/latest/` and writes full-tree snapshots at lane boundaries under `prediction/snapshots/root/<N>/` and `prediction/snapshots/threads/<thread>/<N>/`.
3. `materialize` remains a separate implementation-application step.
4. `test future` and `test now` make the verification target explicit.
5. `test` without an action is still accepted for compatibility and maps to `test now`.
