# CLI

`rundown` and `rd` (strict alias) share the same Commander tree from [src/presentation/cli.ts](../../implementation/src/presentation/cli.ts). Per-command translation to application options lives in [src/presentation/cli-command-actions.ts](../../implementation/src/presentation/cli-command-actions.ts).

## Files

| File | Topic |
|---|---|
| [command-surface.md](command-surface.md) | The full command tree at a glance |
| [execution-commands.md](execution-commands.md) | `run`, `materialize`, `call`, `do`, `loop` |
| [planning-commands.md](planning-commands.md) | `plan`, `research`, `explore`, `query`, `translate` |
| [prediction-commands.md](prediction-commands.md) | `start`, `migrate`, `design`, `test` |
| [review-commands.md](review-commands.md) | `discuss`, `next`, `list`, `log` |
| [maintenance-commands.md](maintenance-commands.md) | `undo`, `revert`, `reverify`, `repair`, `unlock`, `init`, `with`, `config`, `workspace`, memory commands, `worker-health` |
| [global-options.md](global-options.md) | `--config-dir`, `--agents`, output flags |
