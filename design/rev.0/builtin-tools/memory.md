# `memory:` / `memorize:` / `remember:` / `inventory:`

Handler in [src/domain/builtin-tools/memory.ts](../../implementation/src/domain/builtin-tools/memory.ts), registered dynamically by [tool-resolver-adapter.ts](../../implementation/src/infrastructure/adapters/tool-resolver-adapter.ts) (because it depends on `MemoryWriterPort`).

## Behavior

- Runs the worker-execute phase normally (intent: `memory-capture`).
- Captures worker stdout and writes it to the memory store under a named scope.
- Skips verification (memory tasks are usually about recording, not gating).
- Marks the checkbox after a successful write.

## Aliases

`memory:`, `memorize:`, `remember:`, `inventory:` all map to the same handler. Pick the one that reads best in the document.

## Memory storage

Memory layout follows the workspace memory contract — see [../project-layout/memory-layout.md](../project-layout/memory-layout.md). In short:

- Local memory under `<config-dir>/memory/...`.
- Global memory under user-level paths.
- The handler chooses scope based on the prefix and any `scope=...` sub-item.

## Why a dedicated intent

- Memory tasks have **no failure mode** other than worker error. They don't need verification.
- They're idempotent: re-running them updates memory.
- They participate in the trace stream so memory mutations are auditable.

## Workflow integration

`migrate` uses memory to carry context between planner iterations (see [../prediction/migrations.md](../prediction/migrations.md)). The dedicated top-level `memory-clean`, `memory-validate`, and `memory-view` commands inspect and curate the source-local memory used for that scope (see [../cli/maintenance-commands.md](../cli/maintenance-commands.md)).
