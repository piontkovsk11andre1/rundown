# CLI: `--agents`

Print deterministic, Markdown-safe AGENTS guidance to stdout and exit `0`.

Use root `--agents` mode when you need a clean guidance block for `AGENTS.md` generation or automation pipelines.

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
