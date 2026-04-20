# CLI: `design`

Manage design-doc revision lifecycle separately from migration execution.

Use `design` commands for revision snapshots and revision diffs; use `migrate` commands for migration proposal generation, execution, and satellites.

## `rd design release`

Release `design/current/` into the next immutable `design/rev.N/` snapshot.

No-change behavior is preserved: when `design/current/` is byte-for-byte unchanged from the latest revision directory, no new `design/rev.N/` directory is created and the command reports a no-op.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rd design release [options]
```

Arguments:

- None.

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on (used to resolve project root). | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. | unset |
| `--label <text>` | Optional label stored in revision sidecar metadata. | unset |

Examples:

```bash
# Create next immutable design revision snapshot
rd design release --label "snapshot"

# Use explicit workspace for linked/multi-workspace resolution
rd design release --workspace ../platform-core
```

## `rd design diff [target]`

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
rd design diff [target] [options]
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
rd design diff

# Preview diff with source reference listing
rd design diff preview

# Explicit selector form
rd design diff --from rev.2 --to current
```

Migration file naming:

- step migration: `7. Implement Feature.md`
- satellite artifact: `7.1 Snapshot.md`

Use `N. Title.md` for migrations and `N.1` / `N.2` / `N.3` suffixes for snapshot/backlog/review satellites.
