# CLI: `design`

Manage design-doc revision lifecycle separately from migration execution.

Use `design` commands for revision snapshots and revision diffs; use `migrate` commands for migration proposal generation, execution, and satellites.

#### `rundown design release`

Release `design/current/` into the next immutable `design/rev.N/` snapshot.

No-change behavior is preserved: when `design/current/` is byte-for-byte unchanged from the latest revision directory, no new `design/rev.N/` directory is created and the command reports a no-op.

Synopsis:

```bash
rundown design release [options]
```

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

#### `rundown design diff [target]`

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

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on (used to resolve project root). | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. | unset |
| `--from <rev|current>` | Explicit source selector (use with `--to`). | unset |
| `--to <rev|current>` | Explicit destination selector (use with `--from`; must be `current` in this build). | unset |

#### `rundown docs` (deprecated alias)

`rundown docs` remains available as a transition alias for one migration window.

- `rundown docs release` -> deprecated alias for `rundown design release`
- `rundown docs diff` -> deprecated alias for `rundown design diff`
- `rundown docs publish` -> deprecated alias for `rundown design release`
- `rundown docs save` -> removed alias with actionable migration guidance

Migration file naming:

- step migration: `0007-implement-feature.md`
- satellite artifact: `0007--snapshot.md`

Single dash identifies a migration step; double dash identifies a satellite artifact type for the same migration position.
