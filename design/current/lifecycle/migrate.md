# Migrate

`rundown migrate` is a **no-action planning command**. It does not apply migrations; it only authors pending migration files.

## Role in the lifecycle

1. Edit `design/current/` to express intent.
2. Run `rd design release` to snapshot the design into the next immutable `design/rev.N/`.
3. Run `rundown migrate` to converge pending migration intent from design deltas.

`migrate` compares `design/current/` against the latest released baseline and existing migration history, then writes the next numbered migration proposal.

## Planner convergence loop

Implemented in [src/application/migrate-task.ts](../../implementation/src/application/migrate-task.ts).

```text
loop:
  planner.runOne(design + released baseline + existing migrations + memory)
  if output == DONE: break
  parse proposal: filename + seed content
  write migrations/<filename>
  stop if no progress (collision or empty proposal)
```

The loop continues until the planner returns `DONE`, meaning no further migration file is needed for the current design delta.

## What `migrate` does not do

- It does not execute migration actions.
- It does not support `up` or `down` subcommands.
- It does not write snapshots.
- It does not maintain a backlog file.
- It does not edit `design/current/`; design remains human-authored.

## Pending migration consumers

Pending files in [migrations/](../../migrations/) are intent records. They are consumed by:

- external tooling in the new prediction project, and
- humans reviewing design evolution in repository history.

Revision creation remains the responsibility of `rd design release` (see [design-revisions.md](design-revisions.md)).
