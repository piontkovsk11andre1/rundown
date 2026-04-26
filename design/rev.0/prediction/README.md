# Prediction workflow

The migration track is the framework's mechanism for keeping intent (`design/`), prediction (snapshots), and reality (`implementation/` + tests) aligned.

## Files

| File | Topic |
|---|---|
| [design-revisions.md](design-revisions.md) | `design/current/` vs `design/rev.N/`, release semantics, diff |
| [migrations.md](migrations.md) | Migration filename convention, lifecycle, the convergence loop |
| [snapshots-and-backlog.md](snapshots-and-backlog.md) | `N.1 Snapshot.md`, `Backlog.md` singleton, `Review.md` |
| [materialize.md](materialize.md) | `materialize` semantics, commit alignment, revertability |
| [test-modes.md](test-modes.md) | `test` materialized mode vs `--future` predicted mode |
| [undo-and-revert.md](undo-and-revert.md) | Reversal primitives and what they do |
