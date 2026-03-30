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
rundown run README.md -- opencode run
```

What happens:

1. `rundown` selects `Rewrite the opening paragraph for the README`
2. renders the execute prompt from Markdown context,
3. runs `opencode run`,
4. verifies the result,
5. runs repair attempts if configured,
6. and only then marks the task complete.

## 2. PowerShell-safe worker usage

```powershell
rundown run docs/ --worker opencode run
```

This form avoids common PowerShell argument-splitting friction around `--`.

## 3. Interactive TUI handoff

```bash
rundown run roadmap.md --mode tui -- opencode
```

This opens the interactive session, lets the user steer it, then returns to `rundown` for verification and optional repair after exit.

## 4. Inline CLI task

Markdown:

```md
- [ ] cli: npm test
```

Command:

```bash
rundown run . -- opencode run
```

Because the task starts with `cli:`, `rundown` executes `npm test` directly instead of sending the task to the worker.

## 5. Plan first, execute later

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

## 6. Variables for repository context

```bash
rundown run roadmap.md --vars-file --var ticket=ENG-42 -- opencode run
```

This loads `.rundown/vars.json`, overrides `ticket`, and makes those values available in templates.

## 7. Keep artifacts for inspection

```bash
rundown run roadmap.md --keep-artifacts -- opencode run
```

This preserves the per-run folder under `.rundown/runs/` so prompts, logs, and metadata can be inspected later.

## 8. Auto-commit completed tasks

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

## 9. Post-completion hooks

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

## 10. A practical OpenCode setup

A clean default pattern is:

- `rundown run roadmap.md -- opencode run`
- `rundown run roadmap.md --mode tui -- opencode`
- `--transport file` for staged prompt files

This keeps prompt handoff durable, inspectable, and friendly to large Markdown context.

## 11. Reverify before release

```bash
rundown reverify --no-repair -- opencode run
```

Use this to re-check the latest completed task with the current verify template before a push or release cut. The command exits non-zero on verification failure and does not modify Markdown checkbox states.

If historical metadata no longer maps to a unique task after major edits, `reverify` exits with code `3` instead of guessing.

## 12. Revert a previously completed task

```bash
rundown revert --run latest -- opencode run
```

`revert` requires the original run to have been executed with both `--commit` and `--keep-artifacts`; otherwise no revertable run metadata is available.

## 13. Concurrent run protection on one source file

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

## 14. Recover from stale locks

If a previous process crashed and left a stale lockfile, remove it manually:

```bash
rundown unlock roadmap.md
```

Or let `run`/`plan` clear stale locks before acquiring their own lock:

```bash
rundown run roadmap.md --force-unlock -- opencode run
rundown plan roadmap.md --force-unlock -- opencode run
```

`--force-unlock` and `unlock` only remove stale locks. They do not break locks held by a live process.

## 15. Mixed TODO with `cli:` and `rundown:` tasks

Markdown:

```md
# Release prep

- [ ] cli: npm test
- [ ] rundown: docs/release-notes.md --verify --retries 1
- [ ] Publish release notes
```

Command:

```bash
rundown run TODO.md --worker opencode run --verify --retries 2
```

What happens:

1. `rundown` executes `npm test` directly for the `cli:` task.
2. For the `rundown:` task, it delegates to `rundown run docs/release-notes.md --verify --retries 1`.
3. The inline `rundown:` flags override forwarded parent flags when they differ.
4. After the delegated run succeeds, the parent run verifies/checks that task and continues.

## 16. Layered worker profiles from config

Example `.rundown/config.json`:

```json
{
  "defaults": {
    "worker": ["opencode", "run"]
  },
  "commands": {
    "plan": {
      "workerArgs": ["--model", "opus-4.6"]
    }
  },
  "profiles": {
    "fast": {
      "workerArgs": ["--model", "gpt-5.3-codex"]
    },
    "complex": {
      "workerArgs": ["--model", "opus-4.6"]
    }
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

- profile: fast
  - [ ] Fix typo in release notes
  - [ ] Update one CLI flag example

- check:
  - [ ] All tests pass
  - [ ] Linting clean
```

How model selection resolves:

1. `Draft migration plan` inherits frontmatter `complex` and runs with `--model opus-4.6`.
2. Tasks under `- profile: fast` override frontmatter and run with `--model gpt-5.3-codex`.
3. Tasks under `- check:` are verify-only tasks.
4. A CLI worker still overrides all config/profile layers when provided.
