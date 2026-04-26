# Verify-repair loop

The reliability core of `rundown`. Implemented in [src/application/verify-repair-loop.ts](../../implementation/src/application/verify-repair-loop.ts) and dispatched from [src/application/task-execution-dispatch.ts](../../implementation/src/application/task-execution-dispatch.ts).

## Phases

```
EXECUTE → VERIFY → (repair → VERIFY)* → optional RESOLVE → optional RESOLVE_REPAIR
```

| Phase | Source of work | Default outcome on success |
|---|---|---|
| `execute` | worker / inline cli / tool handler | proceeds to verify |
| `verify` | verification worker (or inline tool) | success → completion; failure → repair |
| `repair` | repair worker | re-enters verify |
| `resolve` | optional terminal repair worker (different model) | re-enters verify or `resolveRepair` |
| `resolveRepair` | optional repair-after-resolve worker | re-enters verify |

## Bounded retries

- Default `--repair-attempts <n>`: number of repair iterations before the loop gives up.
- Each iteration runs `repair` then `verify`. The iteration counter is exposed to attempt-aware worker routing (see [../workers/worker-routing.md](../workers/worker-routing.md)).
- `force:` modifier sets the effective attempts to 0 — no repair, single execute+verify.
- `--no-repair` (Commander negated option) disables repair regardless of `--repair-attempts`.

## Verification contract

The verification worker:

- Receives the prompt rendered from the verify template plus task context.
- Must return its result on **stdout** as either `OK` (case-insensitive variants normalized) or a failure reason.
- Must not write the validation sidecar itself; rundown writes `<file>.<index>.validation` based on stdout.

This is a hard contract. Tests assert the stdout shape and rundown's sidecar behavior, never worker-created sidecar files (see repo memory `verification-contract`).

## Worker routing per phase

`run.workerRouting` in [config.json](../../implementation/.rundown/config.json) (and per-project) routes each phase to a different worker, optionally per-attempt:

```json
{
  "run": {
    "workerRouting": {
      "execute": { "worker": [...] },
      "verify":  { "worker": [...] },
      "repair":  {
        "default": { "worker": [...] },
        "attempts": [
          { "selector": { "attempt": 2 }, "worker": [...] },
          { "selector": { "fromAttempt": 3 }, "worker": [...] }
        ]
      },
      "resolve":       { "worker": [...] },
      "resolveRepair": { "default": { "worker": [...] } },
      "reset":         { "worker": [...] }
    }
  }
}
```

The shape is enforced by `worker-config-adapter.ts` validation. See [../workers/worker-routing.md](../workers/worker-routing.md) for routing semantics.

## Failure classification

[src/application/worker-failure-classification.ts](../../implementation/src/application/worker-failure-classification.ts) bucketizes failures into:

- `usage_limit` — quota / rate-limit signals from worker stderr.
- `transport_unavailable` — process spawn / network errors.
- `execution_failure_other` — anything else.

`healthPolicy.cooldownSecondsByFailureClass` decides per-class cooldown. See [../workers/worker-health.md](../workers/worker-health.md).

## What stays unchanged on failure

- The source checkbox.
- The previously-written verification sidecar (a fresh failure overwrites with the new reason).
- Earlier phase artifacts in the same run-id.
