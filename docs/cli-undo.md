# CLI: `undo`

Undo completed task runs using AI-generated reversal actions from execution artifacts.

Unlike `revert`, `undo` is semantic (artifact/context driven) rather than commit-level git history reversal.

## Important: `migrate down` behavior change

`rundown migrate down [n]` is no longer an alias for `rundown undo`.

- `rundown undo` reverses completed execution runs from artifacts.
- `rundown migrate down [n]` operates on prediction artifacts in `migrations/` (removes the last migration files and updates snapshot/backlog state), not on materialized implementation state.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown undo [options] -- <command>
rundown undo [options] --worker <pattern>
```

Arguments:

- None.

Options:

| Option | Description | Default |
|---|---|---|
| `--run <id|latest>` | Target artifact run id or `latest`. | `latest` |
| `--last <n>` | Undo the last `n` completed runs. | `1` |
| `--force` | Bypass clean-worktree safety checks. | off |
| `--dry-run` | Show what would be undone without changing files. | off |
| `--keep-artifacts` | Preserve undo run artifacts under `<config-dir>/runs/`. | off |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Examples:

```bash
# Undo latest completed run
rundown undo

# Undo the last two completed runs
rundown undo --last 2

# Preview undo actions without changing files
rundown undo --dry-run --run latest

# Use explicit worker override
rundown undo --worker "opencode run"
```
