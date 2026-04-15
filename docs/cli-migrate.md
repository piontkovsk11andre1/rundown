# CLI: `migrate`

Generate and manage prediction migrations.

Without an action, `migrate` generates the next migration proposal based on design and migration context.

Design context resolution is revision-aware: it prefers `design/current/**`, includes revision/archive directories (`design/rev.*/**`) as context sources, and falls back to legacy `docs/current/**`, `docs/rev.*/**`, and root `Design.md` for older projects.

Synopsis:

```bash
rundown migrate [action] [options] -- <command>
rundown migrate [action] [options] --worker <pattern>
```

Actions:

- omitted: generate next migration
- `up`: execute migration tasks (`run-all` style)
- `down [n]`: alias of `rundown undo [--last n]`
- `snapshot`: generate `NNNN--snapshot.md`
- `backlog`: generate `NNNN--backlog.md`
- `context`: (re)generate `NNNN--context.md`
- `review`: generate `NNNN--review.md`
- `user-experience`: generate `NNNN--user-experience.md`
- `user-session`: interactive migration discussion session

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Migration directory to operate on. | `./migrations` |
| `--workspace <dir>` | Explicit workspace root for linked/multi-workspace resolution. Required when link metadata is ambiguous. | unset |
| `--confirm` | Print generated content and ask before each write. Non-TTY uses default yes. | off |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Workspace selection notes (`migrate`, `design release`, `design diff`):

- By default, path-sensitive commands resolve workspace from `.rundown/workspace.link`.
- If link metadata has multiple records and no default, command resolution is ambiguous and the command fails with candidate paths.
- Use `--workspace <dir>` to select the effective workspace explicitly (relative to invocation directory).

Prediction workspace placement notes (`migrate`, `design`, `test`, `plan`, `research`, `run` prompt context):

- Bucket paths are resolved from two config layers: `workspace.directories.<bucket>` and `workspace.placement.<bucket>`.
- Effective bucket path rule: selected root (`sourcedir` or `workdir`) + configured relative bucket directory.
- Default placement is `sourcedir` for `design`, `specs`, and `migrations` when placement config is omitted.
- Mixed placement is valid (for example, `design` on `sourcedir`, `specs` on `workdir`, `migrations` on `sourcedir`).
- In linked mode, `sourcedir` maps to the resolved linked workspace, while `workdir` stays at the invocation directory.
- If any two buckets resolve to the same absolute path (including across different roots), command resolution fails with a placement conflict error.

Mixed-placement example:

```json
{
  "workspace": {
    "directories": {
      "design": "design",
      "specs": "checks/specs",
      "migrations": "migrations"
    },
    "placement": {
      "design": "sourcedir",
      "specs": "workdir",
      "migrations": "sourcedir"
    }
  }
}
```

Linked workspace example (resolved roots):

- invocation (`workdir`): `/Users/alex/client-a`
- resolved workspace (`sourcedir`): `/Users/alex/platform-core`
- effective paths:
  - design -> `/Users/alex/platform-core/design`
  - specs -> `/Users/alex/client-a/checks/specs`
  - migrations -> `/Users/alex/platform-core/migrations`
