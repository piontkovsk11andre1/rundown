# Ports and adapters

Every external concern is mediated by a port (a TypeScript interface in [src/domain/ports/](../../implementation/src/domain/ports/)) implemented by exactly one default adapter under [src/infrastructure/adapters/](../../implementation/src/infrastructure/adapters/). Tests substitute fakes for the same ports.

## Mapping table

| Port | Adapter | File |
|---|---|---|
| `FileSystem` | `createNodeFileSystem` | [fs-file-system.ts](../../implementation/src/infrastructure/adapters/fs-file-system.ts) |
| `FileLock` | `createFsFileLock` | [fs-file-lock.ts](../../implementation/src/infrastructure/adapters/fs-file-lock.ts) |
| `ConfigDirPort` | `createConfigDirAdapter` | [config-dir-adapter.ts](../../implementation/src/infrastructure/adapters/config-dir-adapter.ts) |
| `ProcessRunner` | `createCrossSpawnProcessRunner` | [crossspawn-process-runner.ts](../../implementation/src/infrastructure/adapters/crossspawn-process-runner.ts) |
| `GitClient` | `createExecFileGitClient` | [execfile-git-client.ts](../../implementation/src/infrastructure/adapters/execfile-git-client.ts) |
| `TemplateLoader` | `createFsTemplateLoader` | [fs-template-loader.ts](../../implementation/src/infrastructure/adapters/fs-template-loader.ts) |
| `VerificationStore` | `createArtifactVerificationStore` | [artifact-verification-store.ts](../../implementation/src/infrastructure/adapters/artifact-verification-store.ts) |
| `ArtifactStore` | `createFsArtifactStore` | [fs-artifact-store.ts](../../implementation/src/infrastructure/adapters/fs-artifact-store.ts) |
| `Clock` | `createSystemClock` | [system-clock.ts](../../implementation/src/infrastructure/adapters/system-clock.ts) |
| `SourceResolverPort` | `createSourceResolverAdapter` | [source-resolver-adapter.ts](../../implementation/src/infrastructure/adapters/source-resolver-adapter.ts) |
| `TaskSelectorPort` | `createTaskSelectorAdapter` | [task-selector-adapter.ts](../../implementation/src/infrastructure/adapters/task-selector-adapter.ts) |
| `WorkerExecutorPort` | `createWorkerExecutorAdapter` | [worker-executor-adapter.ts](../../implementation/src/infrastructure/adapters/worker-executor-adapter.ts) |
| `TaskVerificationPort` | `createTaskVerificationAdapter` | [task-verification-adapter.ts](../../implementation/src/infrastructure/adapters/task-verification-adapter.ts) |
| `TaskRepairPort` | `createTaskRepairAdapter` | [task-repair-adapter.ts](../../implementation/src/infrastructure/adapters/task-repair-adapter.ts) |
| `WorkingDirectoryPort` | `createWorkingDirectoryAdapter` | [working-directory-adapter.ts](../../implementation/src/infrastructure/adapters/working-directory-adapter.ts) |
| `DirectoryOpenerPort` | `createDirectoryOpenerAdapter` | [directory-opener-adapter.ts](../../implementation/src/infrastructure/adapters/directory-opener-adapter.ts) |
| `PathOperationsPort` | `createNodePathOperationsAdapter` | [node-path-operations-adapter.ts](../../implementation/src/infrastructure/adapters/node-path-operations-adapter.ts) |
| `MemoryResolverPort` | `createMemoryResolverAdapter` | [memory-resolver-adapter.ts](../../implementation/src/infrastructure/adapters/memory-resolver-adapter.ts) |
| `MemoryReaderPort` | `createMemoryReaderAdapter` | [memory-reader-adapter.ts](../../implementation/src/infrastructure/adapters/memory-reader-adapter.ts) |
| `MemoryWriterPort` | `createMemoryWriterAdapter` | [memory-writer-adapter.ts](../../implementation/src/infrastructure/adapters/memory-writer-adapter.ts) |
| `ToolResolverPort` | `createToolResolverAdapter` | [tool-resolver-adapter.ts](../../implementation/src/infrastructure/adapters/tool-resolver-adapter.ts) |
| `InteractiveInputPort` | `createTerminalInteractiveInputAdapter` | [interactive-input-adapter.ts](../../implementation/src/infrastructure/adapters/interactive-input-adapter.ts) |
| `LocaleConfigPort` | `createLocaleConfigAdapter` | [locale-adapter.ts](../../implementation/src/infrastructure/adapters/locale-adapter.ts) |
| `WorkerConfigPort` | `createWorkerConfigAdapter` | [worker-config-adapter.ts](../../implementation/src/infrastructure/adapters/worker-config-adapter.ts) |
| `WorkerHealthStore` | `createFsWorkerHealthStore` | [fs-worker-health-store.ts](../../implementation/src/infrastructure/adapters/fs-worker-health-store.ts) |
| `TemplateVarsLoaderPort` | `createFsTemplateVarsLoaderAdapter` | [fs-template-vars-loader-adapter.ts](../../implementation/src/infrastructure/adapters/fs-template-vars-loader-adapter.ts) |
| `TraceWriterPort` | `createNoopTraceWriter` (default), `createJsonlTraceWriter`, `createFanoutTraceWriter` | [noop-trace-writer.ts](../../implementation/src/infrastructure/adapters/noop-trace-writer.ts), [jsonl-trace-writer.ts](../../implementation/src/infrastructure/adapters/jsonl-trace-writer.ts), [fanout-trace-writer.ts](../../implementation/src/infrastructure/adapters/fanout-trace-writer.ts) |
| `CommandExecutor` (cli-block) | `createCliBlockExecutor` | [cli-block-executor.ts](../../implementation/src/infrastructure/cli-block-executor.ts) |
| `ApplicationOutputPort` | presentation-side renderers | [output-port.ts](../../implementation/src/presentation/output-port.ts), [logged-output-port.ts](../../implementation/src/presentation/logged-output-port.ts) |

## Conventions

- **Names**: ports end in `Port` (or domain noun like `FileSystem`, `Clock`, `GitClient` for very stable contracts). Adapter factories use `create<Name>` exclusively.
- **Pure interfaces**: ports under `src/domain/ports/` only contain types and interfaces; they have no runtime exports. The `ports/**` glob is excluded from coverage.
- **Single composition root**: only [src/create-app.ts](../../implementation/src/create-app.ts) imports adapters. Use cases never reach into `src/infrastructure/*`.
- **Testability**: every use case test substitutes ports directly; no global mocking of `node:fs` or `child_process`.
- **Trace writer default**: noop. Tracing is opt-in (`--trace`) via `createJsonlTraceWriter` (with `createFanoutTraceWriter` allowing multiple destinations).
