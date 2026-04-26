# Public API

What the published `@p10i/rundown` library exposes via [implementation/src/index.ts](../../implementation/src/index.ts).

## Surface area policy

The CLI is the **primary** product. The library export exists so that:

1. consumers can embed rundown in higher-level tooling,
2. integration tests can drive the runtime without shelling out,
3. plugins (future) can implement custom ports.

Internal modules (`domain/*`, `application/*`, `infrastructure/*`) are **not** part of the contract. Only what `index.ts` re-exports is stable.

## Stability tiers

| Tier | What it means |
|---|---|
| Stable | Breaking changes require a major version bump |
| Experimental | May break in any minor release; documented per-export |
| Internal | Anything not re-exported from `index.ts`; may break at any time |

The current public surface is small and pre-1.0 (`1.0.0-rc.x`), so most exports are still **Experimental** — a 1.0.0 release will lock the contract.

## Likely public exports

Based on the architecture, the library re-exports:

- **`composeApp(ports)`** — composition-root entry from [src/create-app.ts](../../implementation/src/create-app.ts). Lets callers replace any port with a custom adapter.
- **Port types** — TypeScript types from `src/domain/ports/*` (read-only), so callers can implement adapters with the right signatures.
- **Use case constructors** — `createRunUseCase`, `createPlanUseCase`, etc., from `src/application/*` for direct programmatic invocation.
- **CLI entry** — for embedding the CLI itself, e.g. inside a wrapper binary.

The exact list lives in [src/index.ts](../../implementation/src/index.ts) and is the authoritative source.

## Type declarations

Shipped via tsup `dts: true` for the library entry. Consumers get full type safety:

```ts
import { composeApp, type Ports } from "@p10i/rundown";

const app = composeApp({
  // override any port with your own adapter
  workerExecutorPort: myWorker,
});

await app.run("plan.md");
```

## What's NOT exported

- The Markdown AST from `mdast-util-from-markdown`. Consumers who need it should depend on it directly.
- Internal helpers (path utilities, string formatters, logging shims).
- Vendored copies of any dependency.

## Versioning policy (post-1.0)

| Change | Bump |
|---|---|
| Adding a new export | minor |
| Adding a property to a returned object | minor |
| Adding a port slot to `Ports` | minor (with default adapter) |
| Removing or renaming an export | major |
| Changing return types narrowly (e.g. broadening) | minor; opposite is major |
| Behavioral breaking change | major |

## Stability of CLI vs library

The CLI surface (commands, flags, exit codes) follows the same versioning, but is documented separately under [../cli/](../cli/). A change that is library-breaking but CLI-compatible (e.g. renaming a port) still bumps major because the public package version is one number.

## Why not split into two packages

For now, one package keeps the dependency graph small and the docs unified. If the library surface grows, splitting `@p10i/rundown` (CLI) and `@p10i/rundown-core` (library) is a viable future move.
