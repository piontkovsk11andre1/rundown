# Concurrency and safety

Cross-cutting safety properties of the GitHub workflows.

## Concurrency groups

| Workflow | Group | Cancel? |
|---|---|---|
| CI | (none — independent per-PR) | n/a |
| Agent — Design Release | `agent-design-release` | `false` |
| Agent — Materialize | `agent-materialize-main` | `false` |
| Release | (none — release event is unique) | n/a |

`cancel-in-progress: false` on agent workflows because:

- An in-flight `materialize` may have written commits but not yet opened a PR; killing it would orphan a branch.
- `design release` snapshots are atomic-per-revision; killing mid-snapshot leaves an incomplete `design/rev.<N>/`.

## Permissions (default-deny)

Every job declares `permissions:` explicitly. Defaults at the workflow root are not used. This forces a review of every new privilege.

| Privilege | Granted to |
|---|---|
| `contents: write` | both agent workflows (commit + push) |
| `pull-requests: write` | both agent workflows |
| `issues: write` | materialize (failure reporting) |
| `models: read` | both agent workflows (GitHub Models access) |
| `packages: write` | release `publish-github-packages` only |
| `id-token: write` | release `publish-npm` (OIDC provenance) |

## Secrets

| Secret | Used by | Scope |
|---|---|---|
| `NPM_TOKEN` | `publish-npm` job | npm registry publish only |
| `GITHUB_TOKEN` | every workflow | implicit; default repo permissions limited by `permissions:` block |

`GITHUB_TOKEN` is preferred over PATs everywhere. The agent workflows use `gh` CLI, which authenticates via `GITHUB_TOKEN` automatically.

## Bot identity

Agent workflows commit as `github-actions[bot] <github-actions[bot]@users.noreply.github.com>`. Branch protection rules can require human review before merging bot commits — recommended setup is "all PRs require one approval" with the bot account excluded from approver list.

## File lock as secondary protection

Even with concurrency groups, two parallel runs against the *same source file* are not impossible — for example, a developer running `rundown` locally while a workflow runs. The source-relative lockfile (`<source-dir>/.rundown/<basename>.lock`) provides a second line of defense; concurrent runs on the same source fail fast. See [../execution/completion-and-locks.md](../execution/completion-and-locks.md).

## Idempotency

| Workflow | Idempotency property |
|---|---|
| design-release | `design release` is a no-op when `design/current/` matches the latest `rev.<N>/` |
| materialize | tasks already checked are skipped; if no unchecked tasks remain, the workflow exits without a PR |
| release | npm rejects republishing the same version, fail-fast |

Re-running an agent workflow on the same commit produces the same result (or no result).

## Artifact retention

| Artifact | Workflow | Retention |
|---|---|---|
| `run-traces-<run_id>` | materialize, on failure | 14 days |
| Build artifacts | none — the published package itself is the artifact | n/a |

Trace uploads are gated on `if: failure()` to avoid noise on green runs.

## Branch protection assumptions

The CI gating story assumes:

- `main` is protected.
- All merges go through PRs.
- CI must pass before merge.
- At least one approval is required for AI-labeled PRs.

These are repo settings, not workflow settings, but the agent loop's correctness depends on them.

## Audit trail

Every agent action is visible:

- A unique branch name with a timestamp.
- A PR labeled `ai-generated`.
- A trace artifact on failure.
- Per-task commits authored by the bot.

This allows a reviewer to reconstruct exactly what the agent did, in which order.
