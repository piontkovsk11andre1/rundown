# CLI: `revert`

Undo previously completed materialized implementation state by restoring filesystem snapshots recorded in saved run artifacts.

By default, `revert` targets the latest snapshot-revertable completed run (`--run latest`).

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown revert [options]
```

Arguments:

- None.

Revertable run requirements:

- The original run status is `completed`.
- The original run metadata includes implementation snapshot targets (`extra.implementationSnapshotTargets`).
- At least one referenced snapshot payload directory still exists on disk.

Snapshot boundaries affect revert granularity:

- Snapshot restore targets map to completed migration boundaries per lane.
- Revert applies run-level implementation-state restoration using those recorded snapshot boundaries.

Options:

| Option | Description | Default |
|---|---|---|
| `--run <id|latest>` | Target a specific run ID or `latest`. | `latest` |
| `--last <n>` | Restore the last `n` snapshot-revertable completed runs (newest-first to oldest). | unset |
| `--all` | Restore all snapshot-revertable completed runs. | off |
| `--method <revert|reset>` | Compatibility option. Both values perform snapshot restore. | `revert` |
| `--dry-run` | Print what would be restored and exit `0` without changing implementation state. | off |
| `--force` | Compatibility no-op for snapshot restore behavior. | off |
| `--keep-artifacts` | Keep artifacts from the `revert` command run. | off |

Target selection validation:

- `--all` and `--last <n>` cannot be combined.
- `--all` or `--last <n>` cannot be combined with `--run <specific-id>`.

Restore method behavior:

- `--method revert` performs snapshot restore.
- `--method reset` is accepted for compatibility and performs the same snapshot restore behavior.

Operational notes:

- Acquires the same per-source Markdown lock used by `run`/`plan`; if another rundown process holds the lock, `revert` fails fast with holder details.
- This lock prevents concurrent `run` + `revert` on the same source file, avoiding task-line drift and unintended checkbox/source mutations from overlapping operations.
- `revert` restores the live `implementation/` tree from snapshot payloads and does not modify git history.
- Multi-run `revert` processes runs newest-first to preserve expected rollback ordering.
- `--force` is accepted but ignored because snapshot restores do not use git precondition or ancestry checks.

Examples:

```bash
rundown revert
rundown revert --run latest
rundown revert --run run-20260319T222645632Z-04e84d73
rundown revert --last 3 --method revert
rundown revert --all --dry-run
rundown revert --last 2 --method reset
```
