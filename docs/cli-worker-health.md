# CLI: `worker-health`

Display persisted worker/profile health status and fallback eligibility snapshots.

The output includes current health entries and fallback-order snapshots used during worker resolution.

Synopsis:

```bash
rundown worker-health [options]
```

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
