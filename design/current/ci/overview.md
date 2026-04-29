# CI overview

Trigger graph and responsibility split among the four workflows in [.github/workflows/](../../.github/workflows/).

## Workflows

| Workflow | File | Trigger |
|---|---|---|
| CI | [ci.yml](../../.github/workflows/ci.yml) | `push` to `main`, all `pull_request` |
| Agent — Design Release | [agent-design-release.yml](../../.github/workflows/agent-design-release.yml) | `push` to `main` touching `design/current/**` |
| Agent — Materialize | [agent-materialize.yml](../../.github/workflows/agent-materialize.yml) | `push` to `main` touching `migrations/**.md` |
| Release Publish | [release.yml](../../.github/workflows/release.yml) | `release: published`, `workflow_dispatch` |

## Composite action

| Action | File | Used by |
|---|---|---|
| Setup Rundown | [.github/actions/setup-rundown/action.yml](../../.github/actions/setup-rundown/action.yml) | both agent workflows |

## Trigger flow

```
Developer commits design/current/...
        │
        ▼
   ci.yml ─────────► tests, lint, build (gate on PR)
        │
        ▼ (after merge)
   agent-design-release.yml
        │   ├─ design release  (snapshot design/current → design/rev.N)
        │   └─ migrate         (write migrations/N. Title.md)
        │
        ▼ opens PR
   ci.yml runs again on PR
        │
        ▼ merged
   agent-materialize.yml
        │   └─ materialize on each pending migration
        │       runs the migration's tasks, commits per task
        │
        ▼ opens PR
   ci.yml runs once more
        │
        ▼ merged → release tagged → release.yml publishes
```

This is the **prediction loop** described in [../overview/prediction-model.md](../overview/prediction-model.md), expressed as GitHub Actions.

## Why three workflows for the agent loop

| Concern | Workflow |
|---|---|
| Snapshot + plan generation | `agent-design-release.yml` |
| Plan execution | `agent-materialize.yml` |
| Source verification | `ci.yml` (acts as the gate before each merge) |

Splitting them lets each step open its own PR with a clear diff, supports targeted re-runs, and isolates failures.

## What every workflow has in common

- `permissions:` is set explicitly per job (default-deny).
- Agent workflows use `concurrency.group` with `cancel-in-progress: false` to prevent overlapping runs.
- Agent workflows commit on a fresh branch and open PRs (no direct push to `main`).
- Failure paths upload `.rundown/runs/` as artifacts where useful (see [agent-materialize.md](agent-materialize.md)).
