# CLI: `docs` (deprecated alias)

`rundown docs` remains available as a compatibility alias for design revision commands during migration.

Use `rundown design ...` as the canonical command family for all new scripts and documentation.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown docs <subcommand> [options]
```

Arguments:

- `<subcommand>`: One of `release`, `publish`, `diff [target]`, or `save`.

Options:

- `release` and `publish` accept `--dir <path>`, `--workspace <dir>`, and `--label <text>`.
- `diff [target]` accepts `[target]`, `--dir <path>`, `--workspace <dir>`, `--from <rev|current>`, and `--to <rev|current>`.
- `save` is removed and accepts no runtime options.

Examples:

```bash
# Deprecated alias for design release
rundown docs release --label "snapshot"

# Deprecated alias for design release
rundown docs publish

# Deprecated alias for design diff
rundown docs diff preview
```

## `rundown docs release`

Deprecated alias for `rundown design release`.

Behavior:

- Prints a deprecation warning: `rundown docs release is deprecated; use rundown design release`.
- Executes the same release flow as `rundown design release` after warning.
- Accepts the same options as `design release` (`--dir`, `--workspace`, `--label`).

Migration guidance:

- Replace `rundown docs release` with `rundown design release`.

## `rundown docs publish`

Deprecated alias for `rundown design release`.

Behavior:

- Prints a deprecation warning: `rundown docs publish is deprecated; use rundown design release`.
- Executes the same release flow as `rundown design release` after warning.
- Accepts the same options as `design release` (`--dir`, `--workspace`, `--label`).

Migration guidance:

- Replace `rundown docs publish` with `rundown design release`.

## `rundown docs diff [target]`

Deprecated alias for `rundown design diff [target]`.

Behavior:

- Prints a deprecation warning: `rundown docs diff is deprecated; use rundown design diff`.
- Executes the same diff flow as `rundown design diff` after warning.
- Accepts the same argument/options as `design diff` (`[target]`, `--dir`, `--workspace`, `--from`, `--to`).

Migration guidance:

- Replace `rundown docs diff ...` with `rundown design diff ...`.

## `rundown docs save`

Removed alias.

Behavior:

- Fails with an actionable error.
- Does not execute any release operation.

Migration guidance:

- Preferred: use `rundown design release`.
- Transitional fallback: `rundown docs publish` remains available as a deprecated alias.

See also:

- Canonical command docs: [cli-design.md](cli-design.md).
- Top-level CLI index: [cli.md](cli.md).

Examples:

```bash
# Canonical replacement for legacy docs release/publish
rundown design release

# Canonical replacement for legacy docs diff
rundown design diff preview
```
