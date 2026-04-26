# Worker routing

Phase-scoped worker selection for `run` and `reverify`. Configured under `run.workerRouting` in [config.json](../../implementation/src/infrastructure/adapters/worker-config-adapter.ts).

## Schema

```json
{
  "run": {
    "workerRouting": {
      "execute":       { "worker": [...], "useFallbacks": false },
      "verify":        { "worker": [...], "useFallbacks": false },
      "repair": {
        "default":  { "worker": [...], "useFallbacks": false },
        "attempts": [
          { "selector": { "attempt": 2 },        "worker": [...], "useFallbacks": false },
          { "selector": { "fromAttempt": 3 },     "worker": [...], "useFallbacks": false }
        ]
      },
      "resolve":        { "worker": [...], "useFallbacks": false },
      "resolveRepair": {
        "default":  { "worker": [...], "useFallbacks": false },
        "attempts": [
          { "selector": { "fromAttempt": 2, "toAttempt": 3 }, "worker": [...], "useFallbacks": false }
        ]
      },
      "reset":          { "worker": [...], "useFallbacks": false }
    }
  }
}
```

## Phases

| Phase | When it fires |
|---|---|
| `execute` | initial task execution |
| `verify` | after execute, after each repair |
| `repair` | each repair retry within the bounded loop |
| `resolve` | terminal repair-style escalation, typically with a stronger model |
| `resolveRepair` | repair after a `resolve` attempt |
| `reset` | `--clean` / `--reset-after` checkbox reset workers |

## Attempt selectors

The `attempts` array on `repair` and `resolveRepair` contains entries with selectors:

- `{ "attempt": N }` — exact attempt match (1-indexed).
- `{ "fromAttempt": N }` — applies from attempt `N` onward.
- `{ "fromAttempt": N, "toAttempt": M }` — half-open range.

If multiple selectors match, the **most specific** wins (exact > range > unbounded). The `default` entry applies when no attempt selector matches.

This enables escalation patterns like "use `sonnet` for first repair attempt, escalate to `opus` from attempt 3 onward".

## `useFallbacks`

Each routing entry can opt into the worker-health fallback chain. When `true`, if the entry's worker is currently `unavailable` or `cooling_down`, rundown advances through `workers.fallbacks` honoring the same health rules. When `false` (default), the entry is "strict" — failure surfaces immediately.

See [worker-health.md](worker-health.md) for the cooling/availability machinery.

## Resolution interaction

Phase routing is **layer 2** in the precedence hierarchy from [resolution-order.md](resolution-order.md). `--worker` on the CLI still wins. Per-command and profile overrides apply *underneath* phase routing. This means:

- A profile chosen via frontmatter is used for *all* phases unless phase routing is also defined.
- Phase routing in `config.json` is the recommended way to vary models across phases without authoring profiles.

## Diagnostics

`--verbose` plus `--trace` together produce:

- one `phase.started` event per phase with the resolved worker,
- a verbose-log line showing the routing entry that won,
- the canonical argv after pattern expansion.
