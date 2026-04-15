# CLI: `with`

`rundown with <harness>` configures worker settings in `<config-dir>/config.json` from a known harness preset.

Use `with` as the fastest onboarding path when you want runnable defaults without editing JSON manually.

Synopsis:

```bash
rundown with <harness>
```

Arguments:

- `<harness>`: preset name or supported alias (case-insensitive).

Supported harness presets:

- `opencode`
- `claude`
- `gemini`
- `codex`
- `aider`
- `cursor`
- `pi`

Behavior:

- Validates `<harness>` against known presets.
- Creates `<config-dir>/config.json` when missing.
- Updates preset-targeted keys (`workers.default`, `workers.tui`, `commands.discuss`) without clobbering unrelated config.
- Preserves other config sections (`workspace`, `trace`, run defaults, tool directories, and other command settings).
- Prints configured keys and resolved config path.
- Unknown harness exits non-zero with an actionable error and the supported preset list.

Examples:

```bash
# Canonical OpenCode onboarding
rundown with opencode

# Alias matching is case-insensitive
rundown with Claude-Code
```

OpenCode conventions applied by `rundown with opencode`:

- Deterministic commands (`run`, `plan`, `research`, `reverify`) use `opencode run` with file-first prompt transport (`$file` + `$bootstrap`).
- Interactive discussion (`discuss`) uses base `opencode`.
- The deterministic/interactive split is persisted via `workers.default`, `workers.tui`, and `commands.discuss`.
