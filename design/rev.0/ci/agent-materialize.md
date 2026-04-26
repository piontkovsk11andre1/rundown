# Agent — Materialize workflow

[`.github/workflows/agent-materialize.yml`](../../.github/workflows/agent-materialize.yml).

Watches `migrations/**.md` on `main`. For each new or modified migration file with unchecked tasks, runs `materialize` and opens a PR with the resulting commits.

## Trigger

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'migrations/**.md'
```

## Concurrency

```yaml
concurrency:
  group: agent-materialize-main
  cancel-in-progress: false
```

One materialize run on `main` at a time.

## Permissions

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write       # for failure reporting
  models: read
```

## Pipeline

### 1. Detect pending migrations

```bash
PENDING=""
for f in $(git diff --name-only HEAD~1 HEAD -- 'migrations/*.md'); do
  if [ -f "$f" ]; then
    UNCHECKED=$(node implementation/dist/cli.js list "$f" | wc -l)
    if [ "$UNCHECKED" -gt 0 ]; then
      PENDING="$PENDING $f"
    fi
  fi
done
```

`rundown list` returns only **unchecked** tasks (when used without flags). A migration with all tasks completed produces zero output and is skipped.

### 2. Materialize each file

```bash
for f in $PENDING; do
  node implementation/dist/cli.js materialize "$f"
done
```

`materialize` is the revertable, source-mutating run that turns predictions into reality. Each completed task becomes a separate commit (see [../execution/completion-and-locks.md](../execution/completion-and-locks.md)).

### 3. Push and PR

```bash
git push origin "$BRANCH"
gh pr create --title "feat: materialize migrations" --label ai-generated …
```

The PR body lists which migration files were processed. Reviewers see the per-task commits inside the PR diff.

### 4. Failure path

```yaml
- name: Upload run traces on failure
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: run-traces-${{ github.run_id }}
    path: .rundown/runs/
    retention-days: 14
```

On any failure the trace directory is uploaded as a build artifact for 14 days, enabling post-mortem analysis without committing trace data.

## Idempotency

If a re-run finds no pending migrations (`UNCHECKED == 0`), the workflow exits cleanly without producing a branch or PR. Safe to re-trigger.

## Per-task commits

The combination of `materialize` + per-task commits + a single PR is intentional:

- Each commit is independently revertable in git.
- The PR itself is one logical change ("materialize migration N").
- Review comments can pin to individual commits.

## Connection to release flow

After a materialize PR merges, `release.yml` fires only on tagged releases. The team controls release cadence — multiple materialize PRs can accumulate before a tag.
