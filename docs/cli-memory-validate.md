# CLI: `memory-validate`

`rundown memory-validate <source>` validates source-local memory consistency and reports issues.

Checks include orphaned index entries, missing index entries for body files, entry-count mismatch, summary drift, and stale source references.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown memory-validate <source> [options]
```

Arguments:

- `<source>`: file, directory, or glob to scan for Markdown memory.

Options:

| Option | Description | Default |
|---|---|---|
| `--fix` | Auto-fix recoverable index issues while validating. | off |
| `--json` | Print validation report as JSON. | off |

Examples:

```bash
# Human-readable validation report
rundown memory-validate docs/

# Validate and attempt automatic repairs
rundown memory-validate docs/ --fix

# Emit JSON report for automation
rundown memory-validate "docs/**/*.md" --json
```
