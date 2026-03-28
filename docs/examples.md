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
