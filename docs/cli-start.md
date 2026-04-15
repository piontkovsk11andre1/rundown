# CLI: `start`

Scaffold a prediction-oriented project workspace.

By default, `start` creates a design-first project structure and prepares migration/spec workflows:

- `design/current/`
- `design/current/Target.md`
- `AGENTS.md`
- `migrations/`
- `migrations/0001-initialize.md`
- `specs/`
- `.rundown/`

Use `--design-dir`, `--specs-dir`, and `--migrations-dir` to override these workspace directories at bootstrap time. Rundown persists the resolved mapping in `.rundown/config.json` and reuses it across prediction flows (`migrate`, `design`, `test`, and related commands).

Use `--design-placement`, `--specs-placement`, and `--migrations-placement` to choose the placement root for each bucket:

- `sourcedir` (default): resolve bucket path under the effective workspace/source directory.
- `workdir`: resolve bucket path under the invocation/working directory.

Placement defaults are persisted to `.rundown/config.json` under `workspace.placement` and apply to path-sensitive prediction flows.

Placement terminology:

- `sourcedir`: effective workspace/source directory used by command resolution.
- `workdir`: invocation directory where the command was launched.

In non-linked mode, `sourcedir` and `workdir` are the same path. In linked mode, they can differ.

Linked-workspace behavior:

- When `start` is invoked from a linked directory, rundown writes link metadata in both places:
  - target workspace `.rundown/workspace.link` points back to the source workspace (legacy single-path format for compatibility)
  - source workspace `.rundown/workspace.link` is updated in multi-record schema so one source can link to multiple targets
- Existing single-link repositories remain compatible; legacy single-path `workspace.link` still resolves.

Directory override rules:

- Paths must be relative to the project root.
- Paths must resolve inside the project root (for example, `../outside` is rejected).
- Workspace targets must be distinct and non-nested (no duplicates or parent/child overlaps).
- Invalid values fail fast with actionable CLI errors that name the offending option.

Compatibility note: legacy `docs/current/Design.md` and root `Design.md` are still read as fallbacks when `design/current/` is not available.

Synopsis:

```bash
rundown start "<description>" [--dir <path>] [--design-dir <path>] [--specs-dir <path>] [--migrations-dir <path>] -- <command>
rundown start "<description>" [--dir <path>] [--design-dir <path>] [--specs-dir <path>] [--migrations-dir <path>] --worker <pattern>
```

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Target directory for scaffold output. | current working directory |
| `--design-dir <path>` | Design workspace directory name/path for start scaffold. | `design` |
| `--specs-dir <path>` | Specs workspace directory name/path for start scaffold. | `specs` |
| `--migrations-dir <path>` | Migrations workspace directory name/path for start scaffold. | `migrations` |
| `--design-placement <mode>` | Design placement root: `sourcedir` or `workdir`. | `sourcedir` |
| `--specs-placement <mode>` | Specs placement root: `sourcedir` or `workdir`. | `sourcedir` |
| `--migrations-placement <mode>` | Migrations placement root: `sourcedir` or `workdir`. | `sourcedir` |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Examples:

```bash
rundown start "Ship auth flow" -- opencode run
rundown start "Ship auth flow" --design-dir design --specs-dir specs --migrations-dir migrations -- opencode run
rundown start "Ship auth flow" --design-placement sourcedir --specs-placement workdir --migrations-placement sourcedir -- opencode run
rundown start "Ship auth flow" --dir ./predict-auth --design-dir docs --specs-dir checks --migrations-dir changes -- opencode run
```
