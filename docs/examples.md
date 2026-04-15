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

1. `workers.default` for deterministic execution (`opencode run --file $file $bootstrap`),
2. `workers.tui` and `commands.discuss` for interactive discussion sessions (`opencode`),
3. while preserving unrelated `.rundown/config.json` keys.

OpenCode behavior after this setup:

1. Deterministic commands (`run`, `plan`, `research`, `reverify`) resolve to `opencode run` via `workers.default`.
2. Interactive discussion (`discuss`) resolves to `opencode` via `workers.tui`/`commands.discuss`.

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
rundown plan docs/release-plan.md --scan-count 3 -- opencode run
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

`revert` requires the original run to have been executed with both `--commit` and `--keep-artifacts`; otherwise no revertable run metadata is available.

If the original run used `--commit-mode file-done` in run-all mode, revert applies to the single final run-level commit (not each intermediate task).

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
2. `memory:` / `memorize:` / `remember:` / `inventory:` run capture + persist, then verify.
3. `fast:` / `raw:` / `quick:` run execution without verification for that task (inverse of verify-only).
4. `profile=` applies as a modifier and composes with downstream handler tools.
5. `include:` executes tasks from a cloned artifacts copy of the target markdown file and auto-checks include on success.
6. When mixed explicit intent prefixes appear in task text, the first explicit prefix wins (`verify: fast: ...` is verify-only; `fast: verify: ...` is fast-execution).
7. `optional:` / `skip:` are the preferred control-flow prefixes; legacy `end:` / `return:` / `quit:` / `break:` remain compatibility aliases.
8. Unknown prefixes are treated as normal task text and do not fail resolution.

## 21. Release design revisions and diff before migration

Use `rundown design` when you want to manage design-document revisions directly.

```bash
# Release design/current into the next immutable design/rev.N snapshot
rundown design release --dir ./migrations

# Add optional label metadata to the released revision
rundown design release --dir ./migrations --label "Auth v2 baseline"

# When linked workspace selection is ambiguous, choose explicitly
rundown design release --dir ./migrations --workspace ../source-workspace --label "Auth v2 baseline"

# Shorthand diff against current draft
rundown design diff --dir ./migrations

# Preview diff with revision source references
rundown design diff preview --dir ./migrations

# Explicit selector form
rundown design diff --dir ./migrations --from rev.3 --to current
```

What happens:

1. `design release` snapshots `design/current/` into `design/rev.N/` with monotonic revision numbering.
2. `rev.0` is the explicit baseline snapshot when present; if no lower revision exists for a selected target (including `rev.1` as first discovered revision), diff semantics are `nothing -> target`.
3. Legacy `docs/current/Design.md` and `docs/rev.*/` layouts remain readable as compatibility fallback sources.
4. If there is no byte-level change from the latest revision, release is a no-op.
5. `design diff` supports shorthand (`current` / `preview`) and explicit `--from/--to` selectors.
6. Diff output is deterministic and suitable for both human review and migration context.

## 22. Generate migrations after design revision work

After releasing or reviewing diffs, switch back to `migrate` for migration lifecycle commands.

```bash
# Propose next migration from revision-aware context
rundown migrate --dir ./migrations -- opencode run

# When workspace.link has multiple records, select explicitly
rundown migrate --dir ./migrations --workspace ../source-workspace -- opencode run

# Generate satellites for the latest migration position
rundown migrate context --dir ./migrations -- opencode run
rundown migrate snapshot --dir ./migrations -- opencode run
rundown migrate backlog --dir ./migrations -- opencode run

# Execute or roll back migration tasks
rundown migrate up --dir ./migrations -- opencode run
rundown migrate down 1 --dir ./migrations -- opencode run
```

`migrate` intentionally excludes design-revision actions; use `rundown design release` and `rundown design diff` for revision lifecycle work.

If linked workspace resolution is ambiguous (for example `.rundown/workspace.link` has multiple records and no default), `migrate`/`design` commands fail with candidate guidance and require `--workspace <dir>`.
