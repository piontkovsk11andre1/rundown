# Design revisions

`design/current/` is the *living* design directory. `rd design release` snapshots it into the next immutable `design/rev.N/`.

## Release semantics

Implemented in [src/application/docs-revision-task.ts](../../implementation/src/application/docs-revision-task.ts) and [src/application/docs-task.ts](../../implementation/src/application/docs-task.ts).

- `rd design release` finds the highest existing `design/rev.N/` and copies `design/current/` to `design/rev.N+1/`.
- If `design/current/` is **byte-identical** to the highest existing revision, the release is a no-op (no new directory, exit code 0, informative message).
- The release is one filesystem-level copy; no transformation happens to the docs.

## Revision baseline contract

- `rev.0` is the **explicit initial baseline** revision when present.
- The first discovered revision in a repository compares against nothing, even when that revision is `rev.1` (i.e. `rev.0` is absent).
- For any target revision with no discovered lower predecessor, `design diff` semantics are `nothing → target`.

## Single source of truth

The design workspace directory name is configurable via `.rundown/config.json` (`workspace.directories.design`, default `design`). There is **no** built-in fallback to alternative directory or file names: rundown reads and writes only the configured workspace, and the primary file inside `current/` is always `Target.md`.

Rundown is pre-1.0 and not yet published, so no backwards-compatibility layer is maintained. Projects that used earlier ad-hoc layouts (e.g. `docs/current/Design.md`, root-level `Design.md`) must rename their tree to the configured workspace before using revision commands.

## `rd design diff [target]`

[src/application/docs-revision-task.ts](../../implementation/src/application/docs-revision-task.ts) supports:

- shorthand: `current`, `preview`, `rev.N`,
- explicit: `--from <rev> --to <rev>`,
- file-tree diff with stable ordering.

## Why a separate `design/` tree

- Keeps the *what* (intent) physically distinct from the *how* (migrations) and *result* (implementation).
- Lets the design-release workflow trigger on `paths: design/current/**` without false positives from migration or implementation churn (see [../ci/agent-design-release.md](../ci/agent-design-release.md)).
- Makes rev.N immutable by convention, so `rundown migrate` can reason about diffs without worrying that the baseline shifts.

## File organization inside `design/current/`

This very directory you are reading is the canonical structure: small, single-topic files grouped under topical subdirectories with `README.md` indexes. The structure is part of the design contract — don't collapse files back into long unstructured documents.
