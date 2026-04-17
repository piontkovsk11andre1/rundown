# Programmatic API

`@p10i/rundown` exposes a small programmatic surface for embedding the runtime in other tools.

## `createApp`

Factory function that assembles the application from dependency ports.

```ts
import { createApp } from "@p10i/rundown";

const app = createApp(dependencies);
```

### Parameters

`createApp` accepts a `CreateAppDependencies` object supplying port implementations and configuration values. Adapter factories for every port are shipped in the package and wired automatically by the CLI; consumers embedding the library must provide their own or reuse the built-in adapters.

### Return value

Returns an `App` instance whose methods correspond to CLI commands:

| Method | CLI equivalent |
|---|---|
| `runTask` | `rundown run` |
| `planTask` | `rundown plan` |
| `researchTask` | `rundown research` |
| `discussTask` | `rundown discuss` |
| `queryTask` | `rundown query` |
| `designTask` | `rundown design` |
| `testSpecs` | `rundown test` |
| `migrateTask` | `rundown migrate` |
| `reverifyTask` | `rundown reverify` |
| `revertTask` | `rundown revert` |
| `undoTask` | `rundown undo` |
| `helpTask` | `rundown` (no-arg help) |
| `initProject` | `rundown init` |
| `startProject` | `rundown start` |
| `listTasks` | `rundown list` |
| `nextTask` | `rundown next` |
| `unlockTask` | `rundown unlock` |
| `logRuns` | `rundown log` |
| `manageArtifacts` | `rundown artifacts` |
| `viewMemory` | `rundown memory-view` |
| `validateMemory` | `rundown memory-validate` |
| `cleanMemory` | `rundown memory-clean` |
| `viewWorkerHealthStatus` | `rundown worker-health` |
| `configGet` | `rundown config get` |
| `configSet` | `rundown config set` |
| `configUnset` | `rundown config unset` |
| `configList` | `rundown config list` |
| `configPath` | `rundown config path` |
| `withTask` | `rundown with` |
| `workspaceUnlinkTask` | `rundown workspace unlink` |
| `workspaceRemoveTask` | `rundown workspace remove` |

Optional utility methods:

- `emitOutput?` — forward an output event to the configured output port.
- `releaseAllLocks?` — release every file lock held by this instance.
- `awaitShutdown?` — wait for graceful shutdown to complete.

## `resetAllCheckboxes`

Resets all checked task checkboxes in a Markdown source string back to unchecked.

```ts
import { resetAllCheckboxes } from "@p10i/rundown";

const reset = resetAllCheckboxes(source, "tasks.md");
```

### Parameters

- `source` (`string`) — the full Markdown file content.
- `file` (`string`) — the file path used for error messages.

### Return value

Returns a new string with every `[x]` checkbox replaced by `[ ]`.

## Exported types

| Type | Purpose |
|---|---|
| `App` | Shape of the object returned by `createApp` |
| `AppPorts` | Port interfaces required by the application |
| `AppUseCaseFactories` | Factory functions for each use-case |
| `CreateAppDependencies` | Input contract for `createApp` |
| `FileLock` | File lock lifecycle operations |
| `FileLockHolder` | Metadata describing the current lock owner |
| `FileLockMetadata` | Command metadata written alongside a lock |
| `TraceEvent` | Strongly typed trace event emitted during runs |
| `TraceWriterPort` | Trace output boundary (write + flush) |

See also:

- [overview.md](overview.md) — architecture and port/adapter map.
- [cli.md](cli.md) — CLI reference.
