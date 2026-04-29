# Materialize

`rundown materialize <source>` is a thin wrapper over `run --all --revertable`. It is the operation that **collapses prediction onto reality**.

## What it does

1. Acquires the source lock.
2. Iterates every unchecked task in document order.
3. Executes each via the configured worker chain (execute → verify → repair).
4. On success, emits a per-task git commit with revertability metadata (`extra.commitSha`).
5. On any task failure, halts; the source's checkbox state and prior commits are preserved.

## Why a dedicated command

- Communicates intent loudly: "I am taking the prediction to reality now."
- Bundles the right defaults (`--all`, `--revertable`, full commit alignment) without forcing users to remember the combination.
- Is the single trigger point for the agent-materialize CI workflow ([../ci/agent-materialize.md](../ci/agent-materialize.md)).

## Commit alignment

- One commit per completed task.
- Commit message defaults to the task text; configurable via `run.commitMessage`.
- `extra.commitSha` is recorded in the per-task run artifact, enabling `revert <source>` to undo specific tasks.
- Staging excludes `.rundown/runs/**` (see [../execution/completion-and-locks.md](../execution/completion-and-locks.md) commit hygiene note).

## Idempotence

Materialize is idempotent: re-running it on the same source skips already-checked tasks. This is what makes the CI workflow safe to retry on transient failures.

## Failure handling

- A failed task halts the run with `task.failed`/`run.completed` (status `verification-failed` or `execution-failed`).
- Already-completed tasks remain committed.
- The CI workflow uploads `.rundown/runs/` as a job artifact for diagnosis.
- Re-invoking `materialize` after fixing the failure resumes from the next unchecked task.

## Relationship to `run --all`

`materialize` is exactly equivalent to `run --all --revertable` with the same source argument. It exists as a stable, semantically named entry point so:

- the CI workflow can match a single command,
- migration files can reference it without leaking implementation flags,
- future evolution can specialize materialize without affecting `run`.
