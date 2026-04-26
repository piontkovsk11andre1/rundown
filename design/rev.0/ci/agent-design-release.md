# Agent — Design Release workflow

[`.github/workflows/agent-design-release.yml`](../../.github/workflows/agent-design-release.yml).

Watches `design/current/**` on `main`. When a change lands, takes a snapshot and generates the corresponding migrations on a fresh branch, then opens a PR.

## Trigger

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'design/current/**'
```

Path filter is critical — only design changes trigger this workflow.

## Concurrency

```yaml
concurrency:
  group: agent-design-release
  cancel-in-progress: false
```

A single global queue. If two design changes land back-to-back, the second waits for the first to finish. `cancel-in-progress: false` because the in-flight run holds locks and produces a coherent snapshot; cancelling it would orphan partial state.

## Permissions

```yaml
permissions:
  contents: write       # create branches and commits
  pull-requests: write  # open the PR
  models: read          # GitHub Models access for the worker
```

Default-deny everywhere else.

## Pipeline

| Step | Command | Notes |
|---|---|---|
| Checkout | `actions/checkout@v4` with `fetch-depth: 0` | full history for `design release` to compute the next revision |
| Setup Rundown | composite action | builds dist/cli.js |
| Configure git identity | `github-actions[bot]` | bot identity for the bot's commits |
| Create branch | `agent/design-release-<epoch>` | unique per run |
| `design release` | `node implementation/dist/cli.js design release` | copies `design/current/` → `design/rev.<N>/` |
| `migrate` | `node implementation/dist/cli.js migrate` | writes `migrations/<N>. Title.md` + `<N>.1 Snapshot.md` |
| Diff check | `git diff --staged --quiet` | skip commit if nothing changed |
| Commit & push | `chore: design release + generated migrations` | only on changes |
| Open PR | `gh pr create … --label ai-generated` | for human review |

## Why a PR, not a direct commit

The migration plan needs review before it executes. The downstream workflow (`agent-materialize.yml`) only fires when `migrations/**.md` lands on `main`, so the PR gate is the human checkpoint between *predicting* the implementation and *materializing* it.

## Failure modes

- **No diff**: skipped silently (idempotency).
- **Worker failure**: rundown writes a trace under `.rundown/runs/`. The workflow does not currently upload it on failure for design-release; the materialize workflow does.
- **Duplicate revision**: `design release` is idempotent; re-running in the same state is a no-op.

## Connection to other workflows

```
agent-design-release.yml → opens PR
                              │
                              ▼
                          ci.yml (PR gate)
                              │
                              ▼ merge
                          agent-materialize.yml fires on migrations/**
```
