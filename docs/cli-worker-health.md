# CLI: `worker-health`

Display persisted worker/profile health status and fallback eligibility snapshots.

The output includes current health entries and fallback-order snapshots used during worker resolution.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown worker-health [options]
```

Arguments:

- None.

Options:

| Option | Description | Default |
|---|---|---|
| `--json` | Print worker health status as JSON. | off |

Examples:

```bash
# Human-readable status
rundown worker-health

# Machine-readable snapshot
rundown worker-health --json
```
