# Undo and revert

Two reversal primitives, both backed by run artifacts.

## `rundown undo`

[src/application/undo-task.ts](../../implementation/src/application/undo-task.ts).

- Reads the most recent run artifact from `.rundown/runs/`.
- Builds a reverse prompt from the saved task context and execution artifacts.
- Hands it to a worker — the worker performs a *semantic* reversal (not necessarily a literal file revert).
- Useful when the task did something side-effecting that has no commit (e.g. external API call, in-place mutation that wasn't committed).

## `rundown revert <source>`

[src/application/revert-task.ts](../../implementation/src/application/revert-task.ts).

- Operates on revertable runs (`--revertable` was set during execution; `materialize` always sets it).
- Reads `extra.commitSha` from each per-task run artifact.
- Uses `GitClient` to revert those commits in reverse order.
- Also un-checks the corresponding checkboxes in the source so the work re-becomes runnable.

## When to use which

| Situation | Use |
|---|---|
| You committed via `--commit` / `materialize` and want to roll back the git history | `rundown revert` |
| You executed without committing and need a logical undo through the agent | `rundown undo` |
| You want to re-run just the verification (no rollback) | `rundown reverify` |
| You want to run repair on an already-completed task without re-executing | `rundown repair` |

## Run-level vs task-level revert

In `--commit-mode per-task` runs (default), each task carries its own commit and `revert` operates per-task.

In `--commit-mode file-done` runs, only the final run artifact carries `extra.commitSha`. `revert` operates at run-level: the single final commit is reverted, and all completed checkboxes from that run are un-checked together.

## Reverify and repair

These do not roll back; they re-execute parts of the loop:

- **`reverify`** — re-runs the verification phase against an already-checked task, possibly with a different `verify` worker. Useful after worker config changes.
- **`repair`** — runs a single repair pass against a task whose verification sidecar shows failure, without re-executing the original task body.

Both consume the same artifacts as `revert` and emit the same trace events as a normal run.
