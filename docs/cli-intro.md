# CLI: `intro`

Display a built-in introduction to rundown concepts, workflow, and command families.

Use `intro` for quick onboarding when you want a concise orientation before running task commands.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown intro
rd intro
```

Arguments:

- None.

Options:

- No command-specific options.

Examples:

```bash
# Show introduction and workflow guidance
rundown intro

# Equivalent alias form
rd intro
```
