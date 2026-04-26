# Resolution order

The deterministic precedence used to decide which worker (and which arguments) handle a given task. Implemented in [src/domain/worker-config.ts](../../implementation/src/domain/worker-config.ts) (`resolveWorkerConfig`) and applied in [src/application/resolve-worker.ts](../../implementation/src/application/resolve-worker.ts).

## Precedence (highest first)

1. **CLI worker** — `--worker <pattern>` or `-- <argv...>`. Short-circuits everything else, including config existence checks.
2. **Phase routing for the current phase** — `run.workerRouting.<phase>`, possibly attempt-aware. See [worker-routing.md](worker-routing.md).
3. **Per-command override** — `commands.<commandName>` (e.g. `commands.plan`).
4. **Per-intent override for verify-only/memory-capture** — `commands.verify`, `commands.memory`.
5. **Per-tool override** — `commands.tools.<toolName>` for tool-expansion intent.
6. **File-level profile** — `profile: name` in frontmatter, with the profile body looked up in `profiles.<name>`.
7. **Directive-level profile** — `profile=name` on a parent directive list item.
8. **Task-level profile** — `profile=name` sub-item on the task itself. **Only respected for `verify-only` and `memory-capture` intents**; warns "not supported" for others.
9. **`workers.default`** — final fallback.
10. **Previously saved worker** — if none of the above match (e.g. resuming a `reverify`), the worker recorded in the last run artifact for that task is reused.

If after all of the above no worker can be assembled, the task fails with a clear error: `No worker command available`.

## Argument merging

When multiple profiles match (e.g. file-level + task-level), `mergeWorkerProfile` accumulates `workerArgs` (append-only) and replaces `worker` tokens with the most-specific layer. The accumulated arg list is appended after the base command tokens.

## Diagnostic output

`--verbose` emits, per task, which layer won and what the assembled command looks like. This is the principal diagnostic for "why is `rundown` calling the wrong worker?".

## Why this order

- CLI override is sacred: a user pinning a worker on the command line must always win.
- Phase routing follows because in routing-aware workflows the phase is more important than the command name.
- Command and intent overrides come next because they reflect operator-level configuration.
- Profiles come last among config sources because they're author-level annotations.
- The default is a last-resort baseline.
- The "previously saved worker" tier is a soft safety net for re-entry flows; it never overrides anything earlier.

## Health interaction

`No worker command available` can also surface when the resolved worker is currently in `unavailable` status in `<config-dir>/worker-health.json`, with no fallback configured. This is functionally indistinguishable from missing config from the user's perspective. See [worker-health.md](worker-health.md).
