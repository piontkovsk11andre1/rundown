# Worker system

How `rundown` invokes external agent processes.

## Files

| File | Topic |
|---|---|
| [worker-config.md](worker-config.md) | `WorkerConfig` schema, `workers.default`, command overrides, profiles |
| [resolution-order.md](resolution-order.md) | Precedence rules across CLI, frontmatter, directives, sub-items |
| [worker-pattern.md](worker-pattern.md) | `$bootstrap` / `$file` / `--prompt=` placeholder semantics |
| [execution-modes.md](execution-modes.md) | `wait` / `tui` / `detached` modes |
| [worker-routing.md](worker-routing.md) | Phase-scoped routing for execute/verify/repair/resolve/reset |
| [worker-health.md](worker-health.md) | Failure classification, cooldown, fallback strategy |
| [harness-presets.md](harness-presets.md) | `with <harness>` shorthand and persisted preset shape |
