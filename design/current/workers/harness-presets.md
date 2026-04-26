# Harness presets

`rundown with <harness>` writes a known set of config keys for one of several supported agent CLIs. Implemented in [src/application/with-task.ts](../../implementation/src/application/with-task.ts) backed by the registry in [src/domain/harness-preset-registry.ts](../../implementation/src/domain/harness-preset-registry.ts).

## Supported harnesses

The registry currently includes:

- `opencode`
- `claude`
- `gemini`
- `codex`
- `aider`
- `cursor`

Aliases (case differences, hyphenation) normalize to the canonical name.

## What gets written

`with` only ever touches three keys, leaving everything else (profiles, healthPolicy, traceStatistics, …) untouched:

- `workers.default`
- `workers.tui`
- `commands.discuss`

For example, `rundown with opencode` produces:

```json
{
  "workers": {
    "default": ["opencode", "run", "--file", "$file", "$bootstrap"],
    "tui":     ["opencode"]
  },
  "commands": {
    "discuss": ["opencode"]
  }
}
```

## Idempotence

- Re-running `with <harness>` on a project that already has these keys set to the matching arrays is a no-op (reports "no changes").
- Aliases (`OpenCode`, `open-code`) all resolve to the same canonical arrays, so alias drift is impossible.

## Interactive auto-launch

In an interactive terminal, after writing the keys, `with` immediately launches `discuss` against the workspace's primary source if one can be discovered. This makes onboarding a single command. In non-interactive contexts (CI, piped invocations) this auto-launch is skipped.

## When to use

- New project bootstrap immediately after `rundown init` / `rundown start`.
- Switching the dominant agent for a project.
- Setting up CI runners (`with` is shell-friendly and idempotent).

## When **not** to use

- Per-command tuning — use `commands.<name>` directly for that.
- Per-task tuning — use `profiles.<name>` and reference them from frontmatter or directives.
- Phase-specific routing — use `run.workerRouting`.

`with` is intentionally coarse. The fine-grained levers live in the rest of the config schema.
