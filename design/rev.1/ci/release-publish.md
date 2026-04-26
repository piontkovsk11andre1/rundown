# Release Publish workflow

[`.github/workflows/release.yml`](../../.github/workflows/release.yml).

Publishes the rundown CLI to **npm** and **GitHub Packages** in parallel jobs whenever a GitHub release is published (or on manual `workflow_dispatch`).

## Triggers

```yaml
on:
  release:
    types: [published]
  workflow_dispatch:
```

The release tag is created manually after merging a materialize PR; this workflow then runs.

## Jobs

### 1. `publish-npm`

| Step | Notes |
|---|---|
| Checkout | full clone |
| Setup Node 24 | `registry-url: https://registry.npmjs.org` |
| Install | `npm ci` in `implementation/` |
| Stage LICENSE | copies repo-root `LICENSE` into `implementation/` for packaging |
| Compute dist-tag | parses version: `1.0.0-rc.16` → `rc`; stable → `latest` |
| Quality gate | `npm run release:check` — guards against forgotten `console.log`, debug output, etc. |
| Publish | `npm publish --tag <rc|latest>` with `NODE_AUTH_TOKEN: NPM_TOKEN` |

Permissions:

```yaml
permissions:
  contents: read
  id-token: write    # OIDC for provenance
```

### 2. `publish-github-packages`

| Step | Notes |
|---|---|
| Checkout | full clone |
| Setup Node 24 | npm cache |
| Install | `npm ci` |
| Stage LICENSE | as above |
| Compute metadata | `version`, `owner`, `base_name`, `tag` |
| Rewrite scope | `npm pkg set name=@<owner>/<base_name>` so package is scoped to the repo owner |
| Build | `npm run build` |
| Configure registry | `actions/setup-node@v4` again with `registry-url: https://npm.pkg.github.com` |
| Publish | `npm publish --tag <rc|latest>` with `NODE_AUTH_TOKEN: GITHUB_TOKEN` |

Permissions:

```yaml
permissions:
  contents: read
  packages: write
```

## Dist-tag logic

```bash
if [[ "$VERSION" == *"-"* ]]; then
  TAG="${VERSION#*-}"
  TAG="${TAG%%.*}"
else
  TAG="latest"
fi
```

| Version | Tag |
|---|---|
| `1.0.0-rc.16` | `rc` |
| `1.0.0-beta.3` | `beta` |
| `1.0.0` | `latest` |

This keeps prereleases off the `latest` channel by default.

## Why two registries

- **npm** — public discoverability under the canonical scope (`@p10i/rundown`).
- **GitHub Packages** — owner-scoped mirror; allows org-internal installs without npm credentials.

## Quality gate

`npm run release:check` is the last guard. It runs lint, tests, build, and any release-specific assertions (no debug output, version bumped, changelog updated). Failures here block publish.

## Failure modes

- **NPM_TOKEN missing/expired**: `publish-npm` fails; `publish-github-packages` continues independently.
- **GITHUB_TOKEN scoped insufficiently**: covered by explicit `permissions: packages: write`.
- **Version already published**: npm rejects with HTTP 403; the job fails. Redo with a bumped version.
