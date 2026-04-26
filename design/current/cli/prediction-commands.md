# Prediction-lifecycle commands

The commands that move the prediction workflow forward.

## `start "<description>"`

Implementation: [src/application/start-project.ts](../../implementation/src/application/start-project.ts).

Scaffolds a prediction-oriented project from a one-line description. Creates:

- `design/current/` (with seed files derived from the description),
- `migrations/` (initially empty),
- `specs/` (empty),
- `AGENTS.md` (worker guidance),
- `.rundown/` with an empty `config.json` and the chosen workspace bucket placement persisted.

`start` is the recommended entry point for new projects; `init` is the lower-level command that only creates `.rundown/`.

## `migrate [action]`

[src/application/migrate-task.ts](../../implementation/src/application/migrate-task.ts).

| Action | Behavior |
|---|---|
| (none) | Run the planner convergence loop until `DONE` |
| `up` | Execute pending migrations and write `N.1 Snapshot.md` |
| `down [n]` | Remove last `n` migrations, prune their snapshots, optionally append to `Backlog.md`, regenerate the now-current snapshot |
| `memory-clean` | Prune outdated memory entries in the migrate scope |
| `memory-validate` | Validate memory against current state |
| `memory-view` | Read current memory |

The convergence loop respects time/iteration caps from migrations 116/120/121. Loop diagnostics emit per-iteration `phase.started` / `phase.completed` events.

## `design release`

[src/application/docs-revision-task.ts](../../implementation/src/application/docs-revision-task.ts).

Snapshots `design/current/` to the next `design/rev.N/`. No-op if content unchanged. Emits `task.completed` with the revision number.

## `design diff [target]`

Same module. Compares two revisions; supports shorthand (`current`, `preview`, `rev.N`) or explicit `--from`/`--to`.

Note: the historical name `docs` is still wired (the application file is `docs-task.ts` / `docs-revision-task.ts`) but the canonical CLI command is `design` (renamed per migration 100).

## `test [source]`

[src/application/test-specs.ts](../../implementation/src/application/test-specs.ts).

| Option | Effect |
|---|---|
| (default) | Materialized mode — assertions evaluated against current workspace |
| `--future` | Predicted-state mode using latest snapshot |
| `--future <n>` | Predicted-state mode at migration `n` |

Source defaults to `specs/` if not provided. See [../prediction/test-modes.md](../prediction/test-modes.md) for semantics.
