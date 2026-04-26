# CI workflow

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — lint, test, and build the source workspace.

## Triggers

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

Every PR to any branch and every push to `main` triggers a run. Agent-generated PRs (from `agent-design-release.yml` and `agent-materialize.yml`) flow through this gate as well.

## Matrix

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: [24]
```

| Axis | Values | Reason |
|---|---|---|
| OS | `ubuntu-latest`, `windows-latest` | rundown depends on filesystem semantics (locks, atomic renames); both OS families must pass |
| Node | `24` | matches `package.json` `engines.node` |

`fail-fast: false` so a Windows-only failure does not hide a Linux issue.

## Steps

| Step | Command | Purpose |
|---|---|---|
| Checkout | `actions/checkout@v4` | source |
| Setup Node | `actions/setup-node@v4` with `cache: npm` | Node + npm cache |
| Install | `npm ci` | reproducible install |
| Lint | `npm run lint` | static analysis |
| Test | `npm run test` | vitest suite |
| Build | `npm run build` | tsup dual bundle, ensures shipping output compiles |

All steps run with `working-directory: implementation` because the npm package lives in [implementation/](../../implementation/), not the repo root.

## Cache key

```yaml
cache: npm
cache-dependency-path: implementation/package-lock.json
```

This pins the cache to the lockfile of the `implementation` workspace, the only npm root in the repo.

## What CI does NOT do

- It does not run rundown itself; rundown agent loops live in separate workflows.
- It does not publish to npm; that is `release.yml`.
- It does not cross-link with `worker-health.json` — that file is excluded from version control.

## When CI changes

- New tests live under [implementation/__tests__](../../implementation/__tests__/).
- New scripts go in `package.json` and may be wired into new steps here.
- Any new workspace under the repo root that needs CI requires a new job (do not stack working-directories on `test`).
