# Testing

Vitest configuration and test layout. Configs:

- [implementation/vitest.config.ts](../../implementation/vitest.config.ts)
- [implementation/__tests__/](../../implementation/__tests__/)

## Vitest config

```ts
defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include:  ["src/**/*.ts"],
      exclude:  ["src/domain/ports/**"],
    },
  },
});
```

| Setting | Reason |
|---|---|
| `include: __tests__/**` | Tests live in a parallel tree, not next to source |
| `coverage.provider: v8` | Native, fast, no instrumentation pass needed |
| `coverage.include: src/**` | Coverage is measured against the source tree |
| `coverage.exclude: src/domain/ports/**` | Ports are pure interfaces — no executable code to cover |

## `__tests__/` layout

Mirrors the source tree's hexagonal layers:

```
__tests__/
├── domain/             # pure logic, no I/O
├── application/        # use cases, with port mocks
├── infrastructure/     # adapter integration tests
├── presentation/       # CLI surface
├── integration/        # end-to-end flows across layers
└── helpers/            # shared test utilities (fakes, fixtures)
```

This mirroring lets a developer find a unit test for `src/domain/parser.ts` at `__tests__/domain/parser.test.ts`.

## Test categories

| Category | Style | Doubles |
|---|---|---|
| Domain | pure unit | none |
| Application | unit with port fakes | hand-written fakes from `__tests__/helpers` |
| Infrastructure | integration on real filesystem | tmp dirs, no mocks of node APIs |
| Presentation | CLI invocation via in-process commander | injected `OutputPort` capture |
| Integration | full app via `composeApp` with fakes for workers | only the worker layer is faked |

## Helpers

`__tests__/helpers/` holds:

- `make-app.ts` — thin wrapper around the composition root with overridable ports.
- `fake-worker.ts` — deterministic worker double that scripts responses by task or prompt fragment.
- `tmp-source.ts` — write a Markdown source to a temp dir and return absolute paths.
- `with-config-dir.ts` — set up a config dir with config.json + templates for a test.

These keep tests readable and avoid duplicating setup across layers.

## Worker tests

Real worker adapters (e.g. opencode runner) are only exercised in tests that don't shell out — the spawn boundary is covered by structural tests, not network-dependent ones. The CI matrix never makes outbound LLM calls.

## Coverage policy

Coverage is **measured**, not gated. The `release:check` script does not enforce a threshold. Reasons:

- Ports excluded by config; thresholds across mixed coverage classes mislead.
- Some defensive paths (e.g. `process.exit` in CLI startup) are deliberately untested.
- Coverage drops in PRs are caught in code review.

Local exploration: `npm run test -- --coverage` produces an HTML report under `coverage/`.

## Watch mode

`npm run test:watch` for TDD. Vitest's vite-based watcher rebuilds only changed graphs.

## Determinism

- No real network calls in tests.
- Tmp directories use `os.tmpdir()` and are cleaned per test.
- Time-dependent code (run-id generation) accepts a clock port; tests inject a fixed clock.
- Random-seeded code (none currently) would follow the same pattern.

## Failures and CI

CI runs the full suite on Linux and Windows in parallel. Test failures block PR merge. There are no flake-tolerance retries — a flaky test must be fixed at the source.
