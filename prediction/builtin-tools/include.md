# `include:`

Handler in [src/domain/builtin-tools/include.ts](../../implementation/src/domain/builtin-tools/include.ts). Delegation runner in [src/infrastructure/inline-rundown.ts](../../implementation/src/infrastructure/inline-rundown.ts).

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false } }
```

## Behavior

1. The task body specifies a **source** (file, dir, glob).
2. Rundown clones the source(s) into the current run's artifact directory (`<run-dir>/<seq>-rundown-delegate/<source>.md`).
3. Spawns a nested `rundown run --all` against the clone(s).
4. The nested run inherits config, worker, and trace writer from the parent.
5. When the nested run finishes successfully, the `include:` parent is auto-completed.

## Why clone, not run-in-place

- The original file is locked by the parent run's `FileLock`. A nested run cannot acquire it.
- Running on a clone gives the child run write access to its working copy without endangering the parent's source.
- Clone state is part of the parent's artifact bundle, so includes are auditable end-to-end.
- Importantly, this is also how cross-file dependencies are expressed — without a separate dependency syntax.

## Use cases

- Decomposing a long source into sub-files that share execution context.
- Cross-cutting verification ("after X, run all of `verify-suite/`").
- Reusing common task lists (`include: ./common-cleanup.md`).

## Trace and artifacts

The nested run carries its own run-id but is linked to the parent via the `phase: rundown-delegate` artifact directory. Trace events for the child run are emitted into the same writer as the parent (`createFanoutTraceWriter` ensures both are recorded).

## Failure propagation

If the nested run produces `task.failed` or non-zero exit, the parent `include:` task fails with the same reason. The parent's repair loop does **not** retry the include; reversing the include requires rerunning after the underlying source is fixed.
