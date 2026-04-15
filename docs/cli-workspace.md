# CLI: `workspace`

`rundown workspace` manages workspace link metadata and optional workspace cleanup from the current invocation directory.

`workspace` separates metadata unlinking from destructive file cleanup:

- `unlink`: remove link record(s) only (no file deletion)
- `remove`: remove link record(s), with optional on-disk file deletion via `--delete-files`

## `rundown workspace unlink`

Removes workspace link record(s) from the current directory context without touching linked workspace files/directories.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown workspace unlink [options]
```

Arguments:

- None.

Options:

| Option | Description | Default |
|---|---|---|
| `--workspace <dir|id>` | Select a specific workspace record by relative path or record id. | unset |
| `--all` | Unlink all records in the current `.rundown/workspace.link`. | off |
| `--dry-run` | Preview records that would be removed without writing metadata. | off |

Behavior constraints:

- If multiple records exist and no selector is provided, command flow must fail safely with candidate guidance.
- Legacy single-record `workspace.link` format remains supported.
- `--dry-run` prints exactly which records would be unlinked.

## `rundown workspace remove`

Removes workspace link record(s); optionally deletes selected linked workspace files/directories.

Synopsis:

```bash
rundown workspace remove [options]
```

Arguments:

- None.

Options:

| Option | Description | Default |
|---|---|---|
| `--workspace <dir|id>` | Select a specific workspace record by relative path or record id. | unset |
| `--all` | Remove all records in the current `.rundown/workspace.link`. | off |
| `--delete-files` | Delete selected linked workspace files/directories (destructive). | off |
| `--dry-run` | Preview records/files that would be removed without changing disk. | off |
| `--force` | Skip confirmation prompts for destructive cleanup operations. | off |

Behavior constraints:

- By default, `remove` without `--delete-files` is metadata-only.
- File deletion requires explicit confirmation unless `--force` is set.
- Deletion targets outside allowed workspace boundaries must be blocked.
- `--dry-run` prints exactly which records/files would be removed.

Examples:

```bash
# Remove one link record only
rundown workspace unlink --workspace ../predict-auth

# Preview unlinking every record in current workspace.link
rundown workspace unlink --all --dry-run

# Remove one record and preview destructive file cleanup
rundown workspace remove --workspace auth-workspace --delete-files --dry-run

# Remove all records and delete linked files without interactive confirmation
rundown workspace remove --all --delete-files --force
```
