# Runtime artifacts

Files that rundown writes during execution but does not consider part of the project source.

## Layout

```
<config-dir>/
├── runs/
│   └── <run-id>/
│       ├── trace.jsonl        # NDJSON event stream
│       ├── prompts/<task>.md  # rendered prompts (when --keep-prompts)
│       └── outputs/<task>.md  # raw worker outputs (when --keep-outputs)
├── worker-health.json         # health/cooldown state across runs
└── logs/                      # global structured logs (when enabled)

<source-dir>/
└── <basename>.lock            # source-relative lockfile (mandatory)
```

## Run id

Format: `YYYY-MM-DDTHH-mm-ss[-N]` in **local time**, with `-N` suffix only on collision within the same second. See [../execution/trace-and-artifacts.md](../execution/trace-and-artifacts.md).

## Lifetime

| Artifact | Lifetime |
|---|---|
| `runs/<run-id>/` | Until cleared by `clean` or manually |
| `worker-health.json` | Persists; pruned by health policy on read |
| `logs/` | Append-only; truncated by retention policy if configured |
| `<basename>.lock` | Active only while the run holds it; removed at end (success or fail) |

## Why source-relative locks

The lockfile must follow the source file, not the config dir, because:

- A single `.rundown/` can be shared by many sources via discovery.
- Concurrent runs of *different* sources should not block each other.
- Concurrent runs of the *same* source must be detected even when invoked from different working directories.

See [../execution/completion-and-locks.md](../execution/completion-and-locks.md).

## CI considerations

CI workflows must mark `runs/` and `worker-health.json` as "ignored or uploaded as artifacts but never committed". The release workflow uploads them as artifacts on failure for post-mortem analysis. See [../ci/concurrency-and-safety.md](../ci/concurrency-and-safety.md).

## Diagnostic flags

| Flag | Effect |
|---|---|
| `--keep-prompts` | Persist rendered prompts under `prompts/` |
| `--keep-outputs` | Persist worker stdout/stderr under `outputs/` |
| `--print-prompt` | Print the rendered prompt for the next task and exit (does not run the task) |
| `--trace` | Force trace writer on (default for most commands) |
| `--no-trace` | Disable trace writer |
