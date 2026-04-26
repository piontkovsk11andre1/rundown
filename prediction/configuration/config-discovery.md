# Config discovery

How rundown locates the effective `.rundown/` for an invocation. Implemented in [src/infrastructure/adapters/config-dir-adapter.ts](../../implementation/src/infrastructure/adapters/config-dir-adapter.ts).

## Resolution order

1. **`--config-dir <path>`** — if provided, used directly. No walk. Invalid paths are fatal (except for `init`).
2. **Discovery walk** — starting from the command's working directory (or the source file's directory for source-scoped flows):
   - check `<current-dir>/.rundown/`,
   - if exists, stop,
   - else move to parent directory,
   - repeat until filesystem root,
3. **Not found** → discovery returns `undefined`.

## Behavior when discovery returns `undefined`

| Consumer | Fallback |
|---|---|
| Templates (`run`, `discuss`, `plan`, `reverify`) | Use built-in templates from [src/domain/defaults.ts](../../implementation/src/domain/defaults.ts) |
| Vars file lookup | Skipped unless an explicit `--vars-file` is requested |
| Runtime artifacts / global log writers | Lazily create `<cwd>/.rundown/` |
| `init` | Creates `<cwd>/.rundown/` (or `--config-dir` path) |
| `worker-health.json` | Lazily created when first failure is recorded |

## Locale

If a discovered `.rundown/` contains `locale.json`, it is loaded once at app construction. Locale messages are read into memory; subsequent CLI output uses them. See [locale.md](locale.md).

## Important: lockfiles are NOT relocated

Lockfile paths are always source-relative: `<source-dir>/.rundown/<basename>.lock`. The discovered config dir does **not** move them. See [../execution/completion-and-locks.md](../execution/completion-and-locks.md) for rationale.

## Multi-root behavior

When a source argument resolves to multiple files in different directories (e.g. a glob spanning subtrees), each file's lockfile sits next to that file, but the config-dir resolution is **single** for the invocation: discovery starts at the working directory of the CLI invocation, not per-source. This keeps templates, vars, and trace targets unified across the run.

## Why upward walk

- Mirrors `git`'s discovery model — natural for users.
- Allows nested projects to share a parent's config when desired.
- Lets a user run `rundown` from any subdirectory of a workspace.

## CLI lifecycle

[src/presentation/cli-app-init.ts](../../implementation/src/presentation/cli-app-init.ts):

- `resolveExplicitConfigDirFromArgv(argv)` extracts `--config-dir` early.
- `validateExplicitConfigDirOption(...)` enforces the strict-existence rule with the `init` exception.
- `createAppForInvocation(...)` constructs an `App` with the resolved (or discovered) config dir, locale messages, output port, and (optionally) trace writer.

This means each CLI invocation builds its own app — a cheap operation backed by the composition root.
