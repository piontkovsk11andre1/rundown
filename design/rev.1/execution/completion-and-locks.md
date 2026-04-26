# Completion and locks

After verification passes, the iteration completes the task. This is the only path that flips the checkbox.

## Completion sequence

[src/application/complete-task-iteration.ts](../../implementation/src/application/complete-task-iteration.ts):

1. Re-read source from disk (defends against drift).
2. Compute new checkbox text via [src/domain/checkbox.ts](../../implementation/src/domain/checkbox.ts).
3. Write source atomically (temp-file + rename via `FileSystem`).
4. Persist the validation sidecar `<file>.<index>.validation`.
5. Run post-task hooks (`hooks.ts`).
6. Optionally commit (see *Commit modes* below).
7. Emit `task.completed` trace event.
8. Release any short-lived per-task resources (artifacts in `--keep-artifacts=false` mode are kept until run finalize).

## File locks

- Lock implementation: `createFsFileLock` in [src/infrastructure/adapters/fs-file-lock.ts](../../implementation/src/infrastructure/adapters/fs-file-lock.ts).
- Path: `<source-dir>/.rundown/<basename>.lock` (source-relative, deliberately not under the upward-discovered `--config-dir`). This avoids basename collisions when two unrelated directories contain a `tasks.md`.
- Lock metadata: `FileLockMetadata` records pid, hostname, and start time so stale-lock detection can run.
- `rundown unlock <source>` releases a stuck lock by mapping the source path to its local lockfile.
- The loop holds the lock across the *entire* multi-task run; tasks within a single source share one lock holder.

## Commit modes

`--commit` triggers per-task git commits via `GitClient`. The mode is selectable:

| Mode | Behavior |
|---|---|
| `per-task` (default) | Commit after each successful completion. Each commit message uses task text or `commitMessage`. |
| `file-done` | Commit once after the whole run finishes successfully. |

`file-done` only applies to run-all flows (`run --all`, `all`, implicit-all from `--redo`/`--clean`). Single-task runs always behave as `per-task` regardless of mode. Multi-round runs in `file-done` produce one commit at the end of the final round. Commit-staging excludes transient `.rundown/runs/**` artifacts (see repo memory `gitops-notes`).

## Revertable runs

`--revertable` (and `materialize`, which implies it) records `extra.commitSha` in the run artifact so `rundown revert` can map a task back to its commit. In `file-done` mode the *final* run artifact records the sha; per-task artifacts in that run do not backfill it, so reversal is run-level only.

## Reset modes

- `--clean` resets all checkboxes before the run starts.
- `--reset-after` resets checkboxes after the run completes (used in idempotent CI flows).
- Reset uses the dedicated `reset` worker routing entry when configured, otherwise the default.

## Why source-relative locks

- Per-source scope matches the lock's purpose.
- Avoids name collisions in a shared `<configDir>/locks/` namespace.
- Keeps `unlock` predictable.
- The trade-off is that an upward-discovered config dir does not relocate locks. Templates, vars, runs, and logs follow the upward dir; locks deliberately don't.
