# CLI: `unlock`

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
