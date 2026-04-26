# Review commands

Read-only or interactive views into the workspace.

## `discuss <source>`

[src/application/discuss-task.ts](../../implementation/src/application/discuss-task.ts).

- Launches an interactive TUI session with the configured `workers.tui` worker (default `commands.discuss`).
- Source is loaded as context; the user can converse, propose edits, or run worker commands.
- Per migration 137, the discuss session has access to artifact links for the most recent run.
- Does **not** mutate the source unless the worker explicitly writes (which still has to pass downstream verification when the task is later run).
- Trace events: `discussion.started`, `discussion.completed` or `discussion.cancelled`, plus `discussion.finished.*` when the session is wrapped up via the finish flow.

## `next <source>`

Prints the next runnable task without executing. Output includes:

- the task line,
- the resolved intent,
- the resolved worker (mirrors `--verbose` resolution diagnostics).

Useful for dry-checking what `run` would do.

## `list <source>`

Lists unchecked tasks. With `--all`, includes checked ones. Output format:

```
[file.md]
  - [ ] task A
    sub-item
    - [ ] nested A.1
  - [ ] task B
```

Nested checkboxes are rendered as children; non-checkbox bullets are rendered as sub-items, matching the parser's hierarchy.

## `log`

[src/application/log-runs.ts](../../implementation/src/application/log-runs.ts).

- Lists past runs with timestamp (in **local time** per migration 102), command, source, status.
- `--run <id>` opens a specific run dir.
- `--trace <id>` prints the JSONL trace for inspection.
- Backed by the global invocation log plus the per-run artifact dirs.
