# CLI: `init`

Create a `.rundown/` directory with default templates, scaffold `tools/`, and initialize `vars.json`/`config.json` when missing.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown init [options]
```

Arguments:

- None.

Options:

| Option | Description | Default |
|---|---|---|
| `--default-worker <command>` | Set `workers.default` in `.rundown/config.json` using the provided CLI command. | unset |
| `--tui-worker <command>` | Set `workers.tui` in `.rundown/config.json` using the provided CLI command. | unset |
| `--overwrite-config` | Replace existing `.rundown/vars.json` and `.rundown/config.json` instead of preserving them. | off |
| `--gitignore` | Ensure `.rundown` is present in project `.gitignore` (create file if missing). | off |

Behavior notes:

- `init` does not rely on task discovery; it bootstraps local project files.
- Existing template files are preserved and reported as skipped.
- By default, existing `.rundown/config.json` and `.rundown/vars.json` are preserved; use `--overwrite-config` to replace them.
- When worker options are passed, `config.json` is generated with a `workers` object (commands are tokenized by whitespace).
- With `--gitignore`, `.rundown` is appended only when not already present.

Examples:

```bash
rundown init
rundown init --default-worker "opencode run" --tui-worker "opencode run --mode tui"
rundown init --overwrite-config
rundown init --gitignore
```
