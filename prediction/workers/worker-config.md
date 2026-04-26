# Worker config

Schema and meaning of `<config-dir>/config.json` worker-related sections. Validated by [src/infrastructure/adapters/worker-config-adapter.ts](../../implementation/src/infrastructure/adapters/worker-config-adapter.ts); types in [src/domain/worker-config.ts](../../implementation/src/domain/worker-config.ts).

## Top-level shape

```json
{
  "workers": {
    "default":   ["string", "..."],
    "tui":       ["string", "..."],
    "fallbacks": [["string", "..."], ["string", "..."]]
  },
  "workerTimeoutMs": 120000,
  "commands": {
    "<commandName>": ["string", "..."],
    "tools.<toolName>": ["string", "..."]
  },
  "profiles": {
    "<profileName>": ["string", "..."]
  },
  "run": { "..." : "see worker-routing.md" },
  "healthPolicy": { "..." : "see worker-health.md" },
  "traceStatistics": {
    "enabled": true,
    "fields": ["total_time", "tokens_estimated"]
  }
}
```

All command and arg arrays must be JSON arrays of strings. Validation errors are path-specific.

## Sections

- **`workers.default`** — global baseline non-TUI worker. Required for any worker-needing command unless `--worker` is provided.
- **`workers.tui`** — baseline worker for TUI-mode executions (currently `discuss` and interactive harness launches).
- **`workers.fallbacks`** — ordered fallback worker commands used when health policy demands failover.
- **`workerTimeoutMs`** — total-runtime cap in milliseconds. `0` disables enforcement; omitting the field leaves no timeout (back-compat default).
- **`commands.<name>`** — per-command override for a defined CLI command (`run`, `plan`, `discuss`, `research`, `reverify`, `verify`, `memory`).
- **`commands.tools.<toolName>`** — override for one tool-expansion prefix invocation (e.g. `tools.post-on-gitea`).
- **`profiles.<name>`** — named reusable worker commands selectable from frontmatter, directives, or `profile=` modifiers.
- **`run.workerRouting`** — phase-scoped routing for `run` / `reverify`. See [worker-routing.md](worker-routing.md).
- **`healthPolicy`** — health tracking. See [worker-health.md](worker-health.md).
- **`traceStatistics`** — controls inline statistic comments written under completed checkboxes.

## Local vs global config

| Path | Purpose |
|---|---|
| `<config-dir>/config.json` (typically `<project>/.rundown/config.json`) | Project-local. Committed to repo, ground truth for CI. |
| Global user-level (`~/.config/rundown/config.json`, macOS/Windows variants) | Optional defaults shared across projects. |

Resolution merges global → local; the local file always wins on key conflicts. If neither exists, commands that need a worker must receive one via `--worker` or `-- <argv>`.

## Empty default

`rundown init` writes `{}`. From that point, worker-required commands fail with a clear "no worker configured" error until either `--worker` is passed or `with <harness>` populates the keys.

## `rundown with <harness>`

[src/application/with-task.ts](../../implementation/src/application/with-task.ts) and [src/domain/harness-preset-registry.ts](../../implementation/src/domain/harness-preset-registry.ts).

Writes only the targeted keys (`workers.default`, `workers.tui`, `commands.discuss`). Idempotent. Aliases (`OpenCode`, `open-code`) normalize to the same keys. Interactive runs may auto-launch `discuss` after writing.

See [harness-presets.md](harness-presets.md).

## traceStatistics

| Field key | Meaning |
|---|---|
| `total_time` | wall-clock time for the task |
| `tokens_estimated` | rough token count from worker output |
| (extensible) | additional fields per future migrations |

When `enabled: false` (default), no inline statistics are written. The canonical event stream (`--trace`) is unaffected.
