# Trace and artifacts

`rundown` persists two streams of evidence for every run: **artifacts** (raw I/O of each phase) and **traces** (typed event stream).

## Artifacts

Implemented by `ArtifactStore` ([fs-artifact-store.ts](../../implementation/src/infrastructure/adapters/fs-artifact-store.ts)) and [runtime-artifacts.ts](../../implementation/src/infrastructure/runtime-artifacts.ts).

```
.rundown/runs/
└── run-<timestamp>-<hash>/
    ├── run.json                       ← run metadata: command, source, status, sha, …
    ├── 01-execute/
    │   ├── prompt.md                  ← rendered prompt the worker received
    │   ├── stdout.log
    │   ├── stderr.log
    │   └── metadata.json              ← worker argv, exit code, duration, classification
    ├── 02-verify/
    ├── 03-repair/
    ├── 04-verify/                     ← each retry adds another phase dir
    └── …
```

Each phase directory is sequentially numbered and labeled with the phase name. The phase set: `execute`, `verify`, `repair`, `resolve`, `plan`, `discuss`, `rundown-delegate`, `pre-run-reset`, `post-run-reset`.

### Retention

- `--keep-artifacts` (default off): on success, the run dir is deleted at finalize. On failure it is always kept.
- `manage-artifacts` (CLI: `rundown log` and friends) can list, prune, or open run dirs.
- The CI materialize workflow uploads `.rundown/runs/` as an Actions artifact on failure with 14-day retention (see [../ci/agent-materialize.md](../ci/agent-materialize.md)).

### Commit hygiene

Run dirs must never be committed. `--commit` staging explicitly excludes `.rundown/runs/**` to prevent dirty-tree deletions when the run dir is cleaned up post-task.

## Trace events

Schema in [src/domain/trace.ts](../../implementation/src/domain/trace.ts), schema_version `1`.

### Event types

`run.started`, `force.retry`, `round.started`, `round.completed`, `discussion.started`, `discussion.completed`, `help.started`, `help.completed`, `discussion.finished.started`, `discussion.finished.completed`, `task.context`, `phase.started`, `phase.completed`, `output.volume`, `cli_block.executed`, `prompt.metrics`, `timing.waterfall`, `agent.signals`, `agent.thinking`, `agent.tool_usage`, `analysis.summary`, `verification.result`, `verification.efficiency`, `usage.limit_detected`, `repair.attempt`, `repair.outcome`, `resolve.attempt`, `resolve.outcome`, `task.completed`, `task.failed`, `run.completed`.

### Event shape

```ts
interface TraceEventBase<T, P> {
  schema_version: 1;
  timestamp: string;   // ISO-8601 UTC
  run_id: string;
  event_type: T;
  payload: P;
}
```

### Run status values

`running`, `completed`, `discuss-completed`, `discuss-cancelled`, `discuss-finished-completed`, `discuss-finished-cancelled`, `help-completed`, `help-cancelled`, `failed`, `detached`, `execution-failed`, `verification-failed`, `reverify-completed`, `reverify-failed`, `reverted`, `revert-failed`, `metadata-missing`.

### Writers

- Default: `createNoopTraceWriter` — events are emitted but discarded.
- `--trace`: CLI swaps in `createJsonlTraceWriter` writing one event per line under the run dir.
- `createFanoutTraceWriter` allows multiple destinations (used in tests and prospective remote sinks).

## Inline trace statistics

`traceStatistics.enabled = true` in `config.json` writes a single comment line under each completed checkbox containing the configured fields (e.g. `total_time`, `tokens_estimated`). This is for human-readable in-source progress summaries; the canonical event stream is the JSONL trace.

## Verification sidecars

Separate from artifacts: each verified task writes `<source>.<index>.validation` next to the source file (or to the verification store path when configured). This is what `reverify` consumes to skip already-verified tasks.

## Global invocation log

`global-output-log.ts` + `cli-invocation-log.ts` write a high-level invocation record for `rundown log`. This is independent of per-run artifacts — it captures *which commands ran when*, not *what each one did*.
