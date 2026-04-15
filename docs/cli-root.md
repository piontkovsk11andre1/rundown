# CLI: Root `rundown`

Run root `rundown` with no subcommand and no positional arguments to start interactive live-help when possible.

Use root no-arg mode for quick onboarding and context-aware guidance before running task commands.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown
rd
```

Arguments:

- None.

Options:

- In interactive terminals (`stdout` and `stderr` are TTY), rundown attempts to launch a TUI help session.
- On successful runtime startup, root `rundown` emits this canonical welcome line first (exact text): "Welcome to rundown. Start with `plan`, `explore`, `run`, or `help`."
- If TTY is unavailable or no worker can be resolved, rundown falls back to static Commander help and exits `0`.
- Worker/config launch errors for this no-arg path also degrade to static help instead of failing hard.
- This no-arg behavior applies only to root help startup; explicit subcommands keep their normal behavior.

Examples:

```bash
# Interactive terminal: opens live help TUI when worker is configured
rundown

# Alias-equivalent form
rd

# Deterministic static help output (non-interactive)
rundown --help
```
