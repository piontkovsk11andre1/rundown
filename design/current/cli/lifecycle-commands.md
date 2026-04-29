# Lifecycle commands

The commands that move the prediction workflow forward.

## `start "<description>"`

Implementation: [src/application/start-project.ts](../../implementation/src/application/start-project.ts).

Scaffolds a prediction-oriented project from a one-line description. Creates:

- `design/current/` (with seed files derived from the description),
- `migrations/` (initially empty),
- `specs/` (empty),
- `AGENTS.md` (worker guidance),
- `.rundown/` with an empty `config.json` and the chosen workspace bucket placement persisted.

Key options:

| Option | Effect |
|---|---|
| `--dir <path>` | Target project directory (default: cwd) |
| `--design-dir <path>` | Design workspace directory (default: `design`) |
| `--design-placement <sourcedir\|workdir>` | Where the design directory is rooted (default: `sourcedir`) |
| `--specs-dir <path>` / `--specs-placement <…>` | Same shape for specs |
| `--migrations-dir <path>` / `--migrations-placement <…>` | Same shape for migrations |

`start` is the recommended entry point for new projects; `init` is the lower-level command that only creates `.rundown/`.

## `migrate [action]`

[src/application/migrate-task.ts](../../implementation/src/application/migrate-task.ts).

| Action | Behavior |
|---|---|
| (none) | Run the planner convergence loop until `DONE` |

Memory-related operations are top-level commands (`memory-view`, `memory-validate`, `memory-clean`), not actions of `migrate`. See [maintenance-commands.md](maintenance-commands.md).

The convergence loop respects time/iteration caps from migrations 116/120/121. Loop diagnostics emit per-iteration `phase.started` / `phase.completed` events.

## `design release`

[src/application/docs-revision-task.ts](../../implementation/src/application/docs-revision-task.ts).

Snapshots `design/current/` to the next `design/rev.N/`. No-op if content unchanged. Emits `task.completed` with the revision number.

## `design diff [target]`

Same module. Compares two revisions; supports shorthand (`current`, `preview`, `rev.N`) or explicit `--from`/`--to`.

Note: the historical name `docs` is still wired (the application file is `docs-task.ts` / `docs-revision-task.ts`) but the canonical CLI command is `design` (renamed per migration 100).

## `test [action] [prompt]`

[src/application/test-specs.ts](../../implementation/src/application/test-specs.ts).

| Action / option | Effect |
|---|---|
| (no action) | Materialized mode — assertions in `--dir` (default `specs/`) evaluated against current workspace |
| `test new "<prompt>"` | Create a new spec assertion file from the given prompt |
| `test new "<prompt>" --run` | Create the spec and immediately verify it |

See [../lifecycle/test.md](../lifecycle/test.md) for semantics.
