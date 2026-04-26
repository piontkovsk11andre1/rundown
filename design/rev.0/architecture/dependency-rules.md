# Dependency rules

Direction of imports is strictly one-way. Violations are treated as design defects.

## Allowed direction

```
presentation → application → domain
                 ↑
infrastructure → domain
                 ↑
              create-app.ts (composition root only)
```

## Concrete rules

1. **`src/domain/*` imports**: only other `src/domain/*` modules and standard TypeScript / language types. No `node:*`, no third-party libs that perform I/O. Domain may import from `mdast-*` parser packages because those are pure data transforms.
2. **`src/application/*` imports**: `src/domain/*` types, ports, and other `src/application/*` files. **Must not import from `src/infrastructure/*`**. All side-effects flow through injected ports.
3. **`src/infrastructure/*` imports**: `src/domain/*` (port interfaces, types) and Node/third-party libraries. May not import from `src/application/*` or `src/presentation/*`.
4. **`src/presentation/*` imports**: `src/application/*`, `src/domain/*` types, and `src/infrastructure/*` only via the composition root (`createApp` from [src/create-app.ts](../../implementation/src/create-app.ts) or [src/presentation/cli-app-init.ts](../../implementation/src/presentation/cli-app-init.ts)).
5. **`src/create-app.ts` imports**: every layer. It is the only legal exception.
6. **Tests**: test files mirror their unit's path under `__tests__/<layer>/...`. Domain tests must not need fakes; application tests use port fakes; infrastructure tests touch the real OS in a temp dir; integration tests run the assembled CLI.

## Output policy

- No use case writes to `console`/`process.stderr`. They emit through `ApplicationOutputPort.emit(event)`.
- The CLI provides the only renderer.
- Errors propagate as thrown values; the CLI converts them to exit codes per [src/domain/exit-codes.ts](../../implementation/src/domain/exit-codes.ts).

## I/O policy

- No use case calls `child_process` or `node:fs` directly. All process spawning goes through `ProcessRunner` or the dedicated worker runner. All file I/O goes through `FileSystem`/`ArtifactStore`/`VerificationStore`/etc.
- All time queries go through `Clock`. This keeps logs and traces deterministic in tests.
- All git interaction goes through `GitClient`.

## Why this matters

The strictness of these rules is what makes the prediction model viable: predictable code is easier to predict. Use cases that depend only on ports can be reasoned about (and tested) without spinning up shells or filesystems, which is exactly what `rundown test --future` needs to do at scale.
