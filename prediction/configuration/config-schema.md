# Config schema

`<config-dir>/config.json` schema (validated by [src/infrastructure/adapters/worker-config-adapter.ts](../../implementation/src/infrastructure/adapters/worker-config-adapter.ts)) plus cross-cutting fields.

```json
{
  "workers": {
    "default":   ["string", "..."],
    "tui":       ["string", "..."],
    "fallbacks": [["string", "..."]]
  },
  "workerTimeoutMs": 120000,

  "commands": {
    "run":       ["string", "..."],
    "plan":      ["string", "..."],
    "discuss":   ["string", "..."],
    "research":  ["string", "..."],
    "reverify":  ["string", "..."],
    "verify":    ["string", "..."],
    "memory":    ["string", "..."],
    "tools.<toolName>": ["string", "..."]
  },

  "profiles": {
    "<profileName>": ["string", "..."]
  },

  "run": {
    "revertable": true,
    "commit": true,
    "commitMessage": "string",
    "commitMode": "per-task",
    "workerRouting": {
      "execute":       { "worker": [...], "useFallbacks": false },
      "verify":        { "worker": [...], "useFallbacks": false },
      "repair": {
        "default":  { "worker": [...], "useFallbacks": false },
        "attempts": [
          { "selector": { "attempt": 2 },                  "worker": [...] },
          { "selector": { "fromAttempt": 3 },              "worker": [...] }
        ]
      },
      "resolve":        { "worker": [...] },
      "resolveRepair": {
        "default":  { "worker": [...] },
        "attempts": [
          { "selector": { "fromAttempt": 2, "toAttempt": 3 }, "worker": [...] }
        ]
      },
      "reset":          { "worker": [...] }
    }
  },

  "healthPolicy": {
    "cooldownSecondsByFailureClass": {
      "usage_limit":             120,
      "transport_unavailable":   0,
      "execution_failure_other": 0
    },
    "maxFailoverAttemptsPerTask": 0,
    "maxFailoverAttemptsPerRun":  0,
    "fallbackStrategy":           "strict_order",
    "unavailableReevaluation": {
      "mode":                  "cooldown",
      "probeCooldownSeconds":  300
    }
  },

  "traceStatistics": {
    "enabled": true,
    "fields": ["total_time", "tokens_estimated"]
  },

  "locale": "en-US",

  "workspace": {
    "design":         "design",
    "migrations":     "migrations",
    "specs":          "specs",
    "implementation": "implementation"
  }
}
```

## Section pointers

| Section | Detailed in |
|---|---|
| `workers.*`, `commands.*`, `profiles.*`, `workerTimeoutMs` | [../workers/worker-config.md](../workers/worker-config.md) |
| `run.workerRouting` | [../workers/worker-routing.md](../workers/worker-routing.md) |
| `run.commit*` | [../execution/completion-and-locks.md](../execution/completion-and-locks.md) |
| `healthPolicy` | [../workers/worker-health.md](../workers/worker-health.md) |
| `traceStatistics` | [../execution/trace-and-artifacts.md](../execution/trace-and-artifacts.md) |
| `locale` | [locale.md](locale.md) |
| `workspace` | [../project-layout/recommended-layout.md](../project-layout/recommended-layout.md) |

## Validation rules

- All command and arg arrays must be JSON arrays of strings (not space-separated strings).
- Numeric fields are validated as non-negative integers.
- Unknown top-level keys are rejected (strict).
- Unknown keys inside extensible sections (`commands.*`, `profiles.*`) are accepted by name match (`commands.tools.<toolName>` for example).
- Validation errors are path-specific — the error message points at the JSON path that failed.

## Local vs global

| File | Path |
|---|---|
| Local | `<config-dir>/config.json` |
| Global (Linux) | `~/.config/rundown/config.json` |
| Global (macOS) | `~/Library/Application Support/rundown/config.json` |
| Global (Windows) | `~\AppData\Roaming\rundown\config.json` |

Merge order: global → local. Local always wins on key conflicts. Either may be absent. `rundown init` writes `{}` locally.
