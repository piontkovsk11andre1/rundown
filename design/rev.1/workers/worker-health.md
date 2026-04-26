# Worker health

`rundown` tracks worker reliability across runs to avoid hammering broken workers and to enable graceful failover.

State lives in `<config-dir>/worker-health.json`, written by [src/infrastructure/adapters/fs-worker-health-store.ts](../../implementation/src/infrastructure/adapters/fs-worker-health-store.ts). Domain logic in [src/domain/worker-health.ts](../../implementation/src/domain/worker-health.ts) and [src/application/worker-health-status.ts](../../implementation/src/application/worker-health-status.ts).

## States

| Status | Meaning | Selectable? |
|---|---|---|
| `healthy` | worker has not failed recently | yes |
| `cooling_down` | recent failure; not selectable until `cooldownUntil` | no, until time passes |
| `unavailable` | sticky failure (manual mode); requires explicit reset | no |

## Failure classification

[src/application/worker-failure-classification.ts](../../implementation/src/application/worker-failure-classification.ts) maps worker exit codes / stderr signals to:

- `usage_limit` — quota or rate-limit signals.
- `transport_unavailable` — process spawn failure, network error, missing binary.
- `execution_failure_other` — generic error.

## Health policy

```json
{
  "healthPolicy": {
    "cooldownSecondsByFailureClass": {
      "usage_limit":               120,
      "transport_unavailable":     0,
      "execution_failure_other":   0
    },
    "maxFailoverAttemptsPerTask":  0,
    "maxFailoverAttemptsPerRun":   0,
    "fallbackStrategy":            "strict_order",
    "unavailableReevaluation": {
      "mode":                  "cooldown",
      "probeCooldownSeconds":  300
    }
  }
}
```

| Field | Purpose |
|---|---|
| `cooldownSecondsByFailureClass` | per-class cooldown duration to apply on failure |
| `maxFailoverAttemptsPerTask` | cap on fallback worker attempts within one task |
| `maxFailoverAttemptsPerRun` | cap across the whole run |
| `fallbackStrategy` | `strict_order` (iterate `workers.fallbacks` in order) or `priority` |
| `unavailableReevaluation.mode` | `cooldown` (default) or `manual` |
| `unavailableReevaluation.probeCooldownSeconds` | retry delay for `cooldown` mode |

## Reevaluation modes

- **`cooldown` (default)**: `transport_unavailable` failures mark the worker `cooling_down` with `cooldownUntil = now + probeCooldownSeconds`. After expiry, the worker is selectable again.
- **`manual`**: legacy sticky behavior. `transport_unavailable` marks the worker `unavailable` until the entry is manually cleared by deleting `<config-dir>/worker-health.json` (or removing the relevant entries).

## Run-time behavior

- At the start of each `runTask` invocation, rundown emits warning lines for any persistent `cooling_down` or `unavailable` entries so blocked workers are visible **before** the loop starts.
- During execution, if all candidates for a phase are `cooling_down`, rundown waits until the **nearest** `cooldownUntil`, retries selection once, and (on continued failure) errors with a health-blocked code.
- Fallback consumption is bounded by `maxFailoverAttemptsPer{Task,Run}`.
- Successful execution clears `cooling_down` for that worker.

## CLI

- `rundown worker-health` — list worker health status (add `--json` for machine-readable output).
- To clear stickiness, delete the `<config-dir>/worker-health.json` file (or remove the relevant entries); deletion = "all healthy".

The inspection command maps to [src/application/worker-health-status.ts](../../implementation/src/application/worker-health-status.ts).

## Why a separate state file

- Survives across CLI invocations so cooldowns persist.
- Lives under `<config-dir>` so per-project policies don't leak.
- Is JSON, hand-readable, and safely deletable: deletion = "all healthy".
