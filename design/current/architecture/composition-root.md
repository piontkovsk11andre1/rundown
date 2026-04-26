# Composition root

[src/create-app.ts](../../implementation/src/create-app.ts) is the single composition boundary. It is the **only** file that imports from `src/infrastructure/`, with the exception of `src/presentation/cli-app-init.ts` which builds the app for CLI invocations.

## Responsibilities

`createApp(dependencies?: CreateAppDependencies): App` produces:

1. A complete `AppPorts` bag — every port either taken from `dependencies.ports` or constructed with its default adapter via `createAppPorts(...)`.
2. A complete set of use-case functions — every use case either taken from `dependencies.useCaseFactories` or built by calling its `create<UseCase>(ports)` factory.
3. A few cross-cutting hooks: `releaseAllLocks`, `awaitShutdown`, `emitOutput`.

## Construction shape

```ts
const ports = createAppPorts(overrides);          // defaults + overrides
const factories = mergeUseCaseFactories(...);     // domain factories
return {
  runTask: factories.runTask(ports),
  planTask: factories.planTask(ports),
  // …one entry per use case
  releaseAllLocks,
  awaitShutdown,
  emitOutput,
};
```

## Dependency injection

`CreateAppDependencies` exposes two override surfaces:

- `ports?: Partial<AppPorts>` — replace any port with a fake/test double. Ports not supplied are constructed from defaults.
- `useCaseFactories?: Partial<AppUseCaseFactories>` — replace any use-case factory. Used in tests to inject mock orchestrators while keeping real ports.

Both are partial; missing entries fall through to defaults. This lets tests vary one piece at a time without rebuilding the whole app.

## Side effects at construction

- Locale messages are read once via `LocaleConfigPort.load(configDir)` and cached on the ports object as `localeMessages`.
- Verification store is constructed with the resolved config dir so per-task `<file>.<index>.validation` sidecars colocate with the source.
- The default `TraceWriterPort` is a no-op; the CLI replaces it with `createJsonlTraceWriter` when `--trace` is passed.
- The default `ApplicationOutputPort` is a no-op; the CLI replaces it with `output-port.ts` (or `logged-output-port.ts` when invocation logging is on).

## Why a single root

- Reproducible app construction in tests (one place to override).
- Static guarantee that `application/*` cannot accidentally pull in infrastructure (an import linter rule could enforce this; today it's enforced by review).
- Cheap re-construction per CLI invocation when `--config-dir` differs across calls in the same process (relevant for integration tests).

## Public API

[src/index.ts](../../implementation/src/index.ts) re-exports `createApp`, `App`, `AppPorts`, `AppUseCaseFactories`, `CreateAppDependencies`, plus a small surface of stable types (`FileLock`, `TraceEvent`, `TraceWriterPort`, `resetAllCheckboxes`). This is the only programmatic entry point — see [../packaging/npm-package.md](../packaging/npm-package.md).
