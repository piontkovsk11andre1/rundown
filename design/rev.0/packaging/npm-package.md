# npm package

[`implementation/package.json`](../../implementation/package.json).

## Identity

| Field | Value |
|---|---|
| `name` | `@p10i/rundown` |
| `version` | `1.0.0-rc.16` (current; bumped per release) |
| `description` | "A Markdown-native task runtime for agentic workflows. Execute, verify, and repair work directly from Markdown TODOs." |
| `license` | MIT |
| `type` | `module` (ESM throughout) |

## Binaries

```json
"bin": {
  "rundown": "dist/cli.js",
  "rd":      "dist/cli.js"
}
```

`rd` is the short alias used in [../cli/command-surface.md](../cli/command-surface.md). Both point at the same bundle; the entry has a `#!/usr/bin/env node` shebang from tsup's `banner`.

## Exports

```json
"main":  "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": {
  ".": {
    "import": "./dist/index.js",
    "types":  "./dist/index.d.ts"
  }
}
```

Single library entry. No deep imports — internal modules are private. See [public-api.md](public-api.md) for the surface area.

## Files allowlist

```json
"files": ["dist", "README.md", "LICENSE"]
```

Only the build output, the README, and the LICENSE ship. Source, tests, configs, and docs do not.

The `release.yml` workflow stages `LICENSE` from the repo root into `implementation/` before publishing because the file lives at the monorepo root, not in the package directory.

## Dependencies (runtime)

| Package | Role |
|---|---|
| `commander` | CLI argument parsing ([../cli/global-options.md](../cli/global-options.md)) |
| `cross-spawn` | Cross-platform child-process spawning for workers |
| `fast-glob` | Source argument expansion |
| `mdast-util-from-markdown` | Markdown AST parser |
| `mdast-util-gfm-task-list-item` | GFM task-list AST extension |
| `micromark-extension-gfm-task-list-item` | GFM task-list parser extension |
| `picocolors` | Lightweight terminal color output |

The dependency footprint is intentionally small. No HTTP client, no LLM SDK — workers shell out to external CLIs.

## Dev dependencies

| Package | Role |
|---|---|
| `tsup` | Bundler ([typescript-and-build.md](typescript-and-build.md)) |
| `typescript` | Type checking |
| `vitest`, `@vitest/coverage-v8` | Test runner ([testing.md](testing.md)) |
| `@types/node`, `@types/cross-spawn` | Types |

## Engines

```json
"engines": { "node": ">=18" }
```

Node 18+ is required; CI tests on Node 24, the current LTS at the time of writing.

## Scripts

| Script | Command |
|---|---|
| `build` | `tsup` |
| `dev` | `tsup --watch` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `lint` | `tsc --noEmit` |
| `release:check` | `npm run lint && npm run test && npm run build` |
| `prepublishOnly` | `npm run release:check` |

`prepublishOnly` is the local belt-and-suspenders gate; CI's `release:check` step duplicates the same guard.

## Overrides

```json
"overrides": { "test-exclude": "^8.0.0" }
```

Pinned to silence a transitive-dependency mismatch in coverage tooling.
