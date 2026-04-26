# Test modes

`rundown test [source]` ([src/application/test-specs.ts](../../implementation/src/application/test-specs.ts)) verifies assertion specs. It has two modes selected by flag.

## Materialized mode (default)

```
rundown test specs/
```

- Reads specs from the source argument (default: `specs/`).
- Each spec contains assertions evaluated against the **current workspace** — the implementation as it exists on disk now.
- Used as a quality gate after `materialize`.
- Pass means: the implementation satisfies the spec right now.

## Future / predicted mode

```
rundown test --future            # against current snapshot
rundown test --future <n>        # against snapshot for migration n
```

- Constructs predicted state by composing `design/rev.K/` and `migrations/N.1 Snapshot.md` (see [snapshots-and-backlog.md](snapshots-and-backlog.md)).
- Without an integer argument, evaluates against the latest snapshot.
- With an integer `n`, evaluates against state predicted up to migration `n`.
- Pass means: the prediction satisfies the spec.

## Spec format

Specs are Markdown files of checkbox-style assertions. Each assertion is a verify-only task whose worker invocation reads the relevant context (workspace files for materialized mode, snapshot text for future mode) and returns `OK` or a failure reason on stdout — same verification contract as the run loop.

## Why two modes from one command

- One source of assertion truth.
- Materialized failures and predicted failures both surface as the same `task.failed` events in traces.
- Operators can ask the same question (does spec `S` hold?) against either reality or prediction without learning a separate command.

## Context resolution

[src/application/design-context.ts](../../implementation/src/application/design-context.ts) and [src/application/prediction-workspace-paths.ts](../../implementation/src/application/prediction-workspace-paths.ts) decide:

- which `design/rev.K/` is the baseline,
- which `migrations/N.1 Snapshot.md` is current for the requested mode/argument,
- where the workspace root is.

These helpers are pure (port-driven) and reused by `migrate`, `discuss`, and `query` flows that need design context.

## Reconciliation

[src/domain/prediction-reconciliation.ts](../../implementation/src/domain/prediction-reconciliation.ts) is the pure helper that composes a baseline revision with snapshot/migration deltas. It is what makes `--future` cheap: no worker call to recompose state, just deterministic file aggregation.
