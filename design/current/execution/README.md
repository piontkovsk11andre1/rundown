# Execution model

The core protocol that every Markdown source flows through: parse → select → execute → verify → repair → complete.

## Files

| File | Topic |
|---|---|
| [workload-protocol.md](workload-protocol.md) | The end-to-end loop and where each phase lives |
| [task-parsing.md](task-parsing.md) | Markdown → `Task[]` with sub-items and intents |
| [task-selection.md](task-selection.md) | Deterministic next-task selection rules |
| [task-intents.md](task-intents.md) | The six intents and how dispatch differs |
| [verify-repair-loop.md](verify-repair-loop.md) | Bounded retries, escalation, resolve phase |
| [completion-and-locks.md](completion-and-locks.md) | Checkbox completion contract, file locks, commit-mode |
| [trace-and-artifacts.md](trace-and-artifacts.md) | What gets persisted, where, and for how long |
