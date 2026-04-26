# `setup-rundown` composite action

[`.github/actions/setup-rundown/action.yml`](../../.github/actions/setup-rundown/action.yml).

A reusable composite action that installs Node, restores npm cache, runs `npm ci`, and builds the rundown CLI so jobs can invoke `node implementation/dist/cli.js …`.

## Steps

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: npm
    cache-dependency-path: implementation/package-lock.json

- run: npm ci
  working-directory: implementation

- run: npm run build
  working-directory: implementation
```

## Why a composite action

Both agent workflows need the same setup. A composite action:

- centralizes the Node version,
- centralizes the cache key,
- centralizes the build command (so one change updates both workflows),
- keeps each workflow file focused on its own logic.

## Output

After this action runs, the job can invoke rundown as `node implementation/dist/cli.js <command>`. The dist bundle is the shipped CLI entry — see [../packaging/typescript-and-build.md](../packaging/typescript-and-build.md).

## What it does NOT do

- It does not install the published `@p10i/rundown` from npm. Agent workflows always run the **current commit's** code, so design/migration generation reflects what's in the repo, not the last release.
- It does not configure git identity. Workflows that commit set their own `user.name`/`user.email`.
- It does not run tests. CI workflow handles that separately.

## Versioning

Because it lives in the same repo as rundown itself, the action is consumed by `uses: ./.github/actions/setup-rundown` (local path), not via a tag. There is no published action version.
