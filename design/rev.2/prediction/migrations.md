# Migrations

Migrations live in [migrations/](../../migrations/) and form a numbered, append-mostly track of predicted change.

## Filename convention

```
migrations/7. Implement Feature.md         ← migration step
migrations/7.1 Snapshot.md                 ← satellite: predicted state after step 7
migrations/7.2 Backlog.md                  ← (deprecated form; see Backlog singleton)
migrations/7.3 Review.md                   ← satellite: prediction-vs-design comparison
migrations/Backlog.md                      ← singleton: deferred work
```

Rules:

- Step number `N` is a positive integer; titles are free text after `N. `.
- Satellite files use dotted suffix `N.M` on the same migration number.
- `Backlog.md` is a singleton (not numbered) at the root of `migrations/`.
- Numbering is monotonic. Renumbering existing files is forbidden — `migrate down` removes from the tail; new work always extends the tail.

Parser: [src/domain/migration-parser.ts](../../implementation/src/domain/migration-parser.ts).

## Lifecycle

1. **Edit** `design/current/` to express new intent.
2. **`rd design release`** snapshots intent.
3. **`rundown migrate`** runs the planner convergence loop:
   - planner reads design + existing migrations,
   - proposes the next migration filename and seed content,
   - rundown creates the file and runs `rundown migrate` step 1 of the new file (its own TODO items),
   - loop until planner returns `DONE`.
4. **`rundown migrate up`** executes pending migrations and writes a `N.1 Snapshot.md` after each.
5. **`rundown migrate down [n]`** removes the last `n` migrations, prunes their snapshots, optionally appends in-flight items to `Backlog.md`, and regenerates the now-current snapshot.
6. **Materialize** when ready (see [materialize.md](materialize.md)).

## The convergence loop

Implemented in [src/application/migrate-task.ts](../../implementation/src/application/migrate-task.ts).

```
loop:
  planner.runOne(design + migrations + memory)
  if output == DONE: break
  parse proposal: filename + seed
  write migrations/<filename>
  exit if no progress (filename collision or empty seed)
```

The planner is a research-only worker invocation when there are no target files (see repo memory in `migration 109. Planner must use memory for research-only tasks`). It reads design + existing migrations + project memory, and writes nothing except the proposed migration content.

## Memory integration

The planner's working knowledge between iterations lives in source-local memory written via the `memory:` built-in tool. It is inspected and curated through the **top-level** memory commands (not subactions of `migrate`):

- `memory-view <source>` — read current memory.
- `memory-validate <source>` — validate against current state.
- `memory-clean <source>` — prune outdated, orphaned, or invalid entries.

See [../cli/maintenance-commands.md](../cli/maintenance-commands.md).

## What `migrate` does **not** do

- It does not edit `design/current/`. Design changes are human-authored.
- It does not run materialization. That is a separate, explicit command and (in CI) a separate workflow.
- It does not auto-renumber. The numeric monotonicity is part of the audit trail.
