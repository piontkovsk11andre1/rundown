# CLI: `design`

Manage design-doc revision lifecycle separately from migration execution.

Use `design` commands for revision snapshots and revision diffs; use `migrate` commands for migration proposal generation, execution, and satellites.

## `rundown design release`

Release `design/current/` into the next immutable `design/rev.N/` snapshot.

No-change behavior is preserved: when `design/current/` is byte-for-byte unchanged from the latest revision directory, no new `design/rev.N/` directory is created and the command reports a no-op.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown design release [options]
```

Arguments:

- None.

Compatibility note:

- `rundown design release` is the canonical snapshot command.
- `rundown docs release` remains available as a deprecated alias and prints guidance to move to `design release`.
- `rundown docs publish` remains available as a deprecated alias and prints guidance to move to `design release`.
- `rundown docs save` is removed and fails with an actionable message that points to `design release`.

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on (used to resolve project root). | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. | unset |
| `--label <text>` | Optional label stored in revision sidecar metadata. | unset |

Examples:

```bash
# Create next immutable design revision snapshot
rundown design release --label "snapshot"

# Use explicit workspace for linked/multi-workspace resolution
rundown design release --workspace ../platform-core
```

## `rundown design diff [target]`

Show revision diff context using either shorthand target or explicit selectors.

Revision contract:

- `rev.0` is the explicit baseline initial state when it exists.
- For target `rev.N`, compare from the nearest discovered lower revision when available.
- If no discovered lower revision exists (including repositories where `rev.1` is the first revision), treat diff as `nothing -> rev.N`.

Shorthand targets:

- omitted / `current`: diff summary output
- `preview`: diff summary + source reference listing

Explicit selector form:

- `--from <rev|current> --to <rev|current>`
- In this build, `--to` must be `current` (for deterministic compare-to-draft behavior)
- You cannot combine shorthand `[target]` with explicit selectors

Synopsis:

```bash
rundown design diff [target] [options]
```

Arguments:

- `[target]`: Optional shorthand target (`current` or `preview`).

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on (used to resolve project root). | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. | unset |
| `--from <rev|current>` | Explicit source selector (use with `--to`). | unset |
| `--to <rev|current>` | Explicit destination selector (use with `--from`; must be `current` in this build). | unset |

Examples:

```bash
# Summary diff against current draft
rundown design diff

# Preview diff with source reference listing
rundown design diff preview

# Explicit selector form
rundown design diff --from rev.2 --to current
```

Migration file naming:

- step migration: `0007-implement-feature.md`
- satellite artifact: `0007--snapshot.md`

Single dash identifies a migration step; double dash identifies a satellite artifact type for the same migration position.
