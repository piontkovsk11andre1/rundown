# Workload protocol

The core loop is implemented across three application files:

- [run-task-execution.ts](../../implementation/src/application/run-task-execution.ts) — outer loop (rounds, source iteration, finishRun)
- [run-task-iteration.ts](../../implementation/src/application/run-task-iteration.ts) — single-task lifecycle
- [task-execution-dispatch.ts](../../implementation/src/application/task-execution-dispatch.ts) — execute/verify/repair routing

## Steps

```
runTask(options)
 ├─ resolve sources via SourceResolverPort (file | dir | glob)
 ├─ acquire FileLock per source (createFsFileLock)
 ├─ for round in 1..rounds:
 │   └─ runTaskLoop()
 │       └─ while not done:
 │           ├─ taskSelector.selectNextTask(files, sortMode)   ← depth-first, parent-checked
 │           ├─ runTaskIteration(task)
 │           │   ├─ resolve intent (task-intent.ts)
 │           │   ├─ dispatchTaskExecution()
 │           │   │   ├─ EXECUTE  → workerExecutor.runWorker()  | toolHandler() | inlineCli
 │           │   │   ├─ VERIFY   → taskVerification.verify()   (if intent demands)
 │           │   │   └─ REPAIR   → bounded loop: repair → re-verify
 │           │   └─ completeTaskIteration()
 │           │       ├─ update checkbox via FileSystem
 │           │       ├─ run hooks (post-task)
 │           │       └─ trace task.completed
 │           └─ trace round.completed
 └─ finishRun() — flush trace enrichment, finalize artifacts, optional final commit
```

## Strictness rules

- **One task at a time.** No promise-based parallelism between tasks. The `parallel:` tool dispatches inline `cli:` blocks together but does not introduce inter-task concurrency.
- **One file at a time per source.** File locks ensure that no two rundown processes touch the same Markdown file. Lockfile path is **source-relative**: `<source-dir>/.rundown/<basename>.lock`.
- **Verification gates the checkbox.** A failed verification leaves the checkbox unchecked; retries happen until `repair-attempts` is exhausted. After exhaustion the task is reported failed and the loop stops (or moves on, depending on `--continue-on-failure`).
- **Hierarchy respected.** A child task does not run until its parent is checked. `parseTasks` builds the tree; `selectNextTask` walks it.

## Failure outcomes

Each task can resolve to one of:

| Outcome | Trace event | Effect |
|---|---|---|
| Verified success | `task.completed` | Checkbox flipped, artifacts retained, optional commit |
| Verification failure (retries exhausted) | `task.failed` | Checkbox stays unchecked, run halts (default) |
| Worker timeout | `task.failed` | Worker SIGTERM'd, deterministic stderr message |
| Worker health blocked | `task.failed` | Cooldown logged, eligible workers re-tried per policy |
| Cancelled | `task.failed` | Cleanup hooks fire, locks released |

## Public effects after each task

- Checkbox toggled in source.
- Verification sidecar `<file>.<index>.validation` written.
- Phase artifacts written under `.rundown/runs/<run-id>/`.
- Optional git commit (per `--commit` and `commitMode`).
- Trace events emitted to configured writer.
