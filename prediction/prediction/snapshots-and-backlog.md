# Snapshots and backlog

Predicted state is materialized into Markdown at well-defined checkpoints.

## `N.1 Snapshot.md`

Written by `migrate up` after migration `N` succeeds. Contains the planner's description of what the world looks like after the cumulative effect of migrations `1..N`. This is the unit `test --future` consumes.

Properties:

- One snapshot per migration step.
- Always uses suffix `.1`. Higher suffixes (`.2`, `.3`, …) are reserved for other satellites (e.g. `Review.md`).
- Snapshot files are not directly executed; they are read-only state descriptions.
- Snapshots are pruned by `migrate down [n]` to keep the prediction track consistent with the migration tail.

## `migrations/Backlog.md` (singleton)

The single, top-level backlog file. Carries:

- in-flight items rolled forward from `migrate down`,
- deferred TODOs surfaced by planner iterations,
- discussion outcomes that did not yet warrant a new migration.

Rules:

- Always a single file at `migrations/Backlog.md`. Never numbered.
- Items are plain unchecked checkboxes; items can be promoted into a new migration step by hand or by the planner.
- `migrate down` decides whether to append rescinded items to `Backlog.md` or drop them, based on how the user invokes it.

## `N.3 Review.md`

Written by review-oriented migrate phases. Compares:

- the snapshot at `N` to the corresponding `design/rev.K/` revision available at the time,
- highlights areas where prediction drifted from intent.

Reviews surface debt that the planner may then encode as additional migrations or as backlog entries.

## Predicted-state semantics for tests

`rundown test --future <n>` builds predicted state by:

1. Loading the most recent snapshot at or before `n` (`max(M.1) where M ≤ n`).
2. Applying the unchecked task content of migrations `M+1 .. n` on top conceptually (rundown does not execute them; the planner's contract is that snapshots already encode their effect).
3. Evaluating the spec assertions against this composed state.

`rundown test` (no `--future`) instead evaluates against the materialized workspace state.

See [test-modes.md](test-modes.md) for the precise semantics.

## Why snapshots are persisted

- They make `test --future` cheap: no need to re-run the planner to obtain predicted state.
- They make migration review tractable — the diff between two snapshots is the predicted effect of the migrations between them.
- They turn the migration track into a verifiable, append-only journal of predicted change.
