# CI and GitHub infrastructure

GitHub Actions workflows and composite actions that automate testing, agent-driven design loops, and release publishing.

## Files

| File | Topic |
|---|---|
| [overview.md](overview.md) | Workflow map and trigger graph |
| [ci-workflow.md](ci-workflow.md) | `ci.yml` — lint/test/build matrix |
| [setup-rundown-action.md](setup-rundown-action.md) | Composite action for installing rundown in a job |
| [agent-design-release.md](agent-design-release.md) | `agent-design-release.yml` — snapshot + migrate |
| [agent-materialize.md](agent-materialize.md) | `agent-materialize.yml` — materialize migrations |
| [release-publish.md](release-publish.md) | `release.yml` — npm + GitHub Packages publish |
| [concurrency-and-safety.md](concurrency-and-safety.md) | Concurrency groups, permissions, secret hygiene, artifact retention |
