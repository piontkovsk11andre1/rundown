# CLI: `memory-clean`

`rundown memory-clean <source>` removes orphaned, outdated, or invalid source-local memory artifacts.

By default, `memory-clean` targets orphaned, invalid, or outdated memory. Use filters to narrow scope.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown memory-clean <source> [options]
```

Arguments:

- `<source>`: file, directory, or glob to scan for Markdown memory.

Options:

| Option | Description | Default |
|---|---|---|
| `--dry-run` | Preview what would be removed without deleting files. | off |
| `--orphans` | Remove only memory whose source file no longer exists. | off |
| `--outdated` | Remove only memory older than threshold. | off |
| `--older-than <duration>` | Age threshold for `--outdated` (for example `30d`, `6m`). | `90d` |
| `--all` | Remove all memory for matched sources. Requires `--force`. | off |
| `--force` | Skip safety confirmation gates for destructive cleanup modes. | off |

Examples:

```bash
# Preview default cleanup selection
rundown memory-clean docs/ --dry-run

# Remove only orphaned memories
rundown memory-clean "docs/**/*.md" --orphans

# Remove all memory for matched sources
rundown memory-clean docs/ --all --force
```
