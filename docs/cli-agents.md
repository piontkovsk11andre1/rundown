# CLI: `--agents`

Print deterministic, Markdown-safe AGENTS guidance to stdout and exit `0`.

Use root `--agents` mode when you need a clean guidance block for `AGENTS.md` generation or automation pipelines.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown --agents
rd --agents
```

Arguments:

- None.

Options:

- `--agents` must be used at the root (subcommand usage is rejected).
- When combined with `--help`, `--agents` takes precedence and emits AGENTS content.
- Output is plain text only (no ANSI colors/spinners/status prefixes), newline-terminated.

Examples:

```bash
# Print AGENTS guidance to terminal
rundown --agents

# Create or overwrite AGENTS.md
rd --agents > AGENTS.md

# Append guidance to existing AGENTS.md
rd --agents >> AGENTS.md
```
