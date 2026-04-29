# Layers

`rundown` is split into four layers under [implementation/src/](../../implementation/src/). Each layer has a strict role and dependency policy.

## Domain — `src/domain/`

Pure business logic. No I/O. No `node:fs`, `child_process`, network, or process-state imports.

Holds:

- **Models**: [parser.ts](../../implementation/src/domain/parser.ts), [task-selection.ts](../../implementation/src/domain/task-selection.ts), [task-intent.ts](../../implementation/src/domain/task-intent.ts), [worker-config.ts](../../implementation/src/domain/worker-config.ts), [worker-pattern.ts](../../implementation/src/domain/worker-pattern.ts), [trace.ts](../../implementation/src/domain/trace.ts), [migration-types.ts](../../implementation/src/domain/migration-types.ts).
- **Algorithms**: planner validation/insertion ([planner.ts](../../implementation/src/domain/planner.ts)), task sorting ([sorting.ts](../../implementation/src/domain/sorting.ts)), checkbox manipulation ([checkbox.ts](../../implementation/src/domain/checkbox.ts)), template variable resolution ([template-vars.ts](../../implementation/src/domain/template-vars.ts)).
- **Built-in tool registry**: [builtin-tools/](../../implementation/src/domain/builtin-tools/) — the static catalog of handler/modifier definitions.
- **Port contracts**: [ports/](../../implementation/src/domain/ports/) — interface-only TypeScript modules. Excluded from coverage by [vitest.config.ts](../../implementation/vitest.config.ts).
- **Static services**: [services/](../../implementation/src/domain/services/) — pure helpers (e.g. output similarity).

## Application — `src/application/`

Use-case orchestration. Depends on domain types and port contracts only — never on `src/infrastructure/*`.

Each file is a use case factory: it accepts a `Dependencies` bag of ports and returns an executable function. Examples:

| File | Use case |
|---|---|
| [run-task.ts](../../implementation/src/application/run-task.ts) | Top-level `run` entry; thin wrapper over execution loop |
| [run-task-execution.ts](../../implementation/src/application/run-task-execution.ts) | Multi-round outer loop |
| [run-task-iteration.ts](../../implementation/src/application/run-task-iteration.ts) | Single-task inner loop (intent → dispatch → complete) |
| [task-execution-dispatch.ts](../../implementation/src/application/task-execution-dispatch.ts) | Routes execute/verify/repair phases |
| [verify-repair-loop.ts](../../implementation/src/application/verify-repair-loop.ts) | Bounded repair retries |
| [plan-task.ts](../../implementation/src/application/plan-task.ts) | Scan-based planner with convergence detection |
| [migrate-task.ts](../../implementation/src/application/migrate-task.ts) | Planner convergence loop for authoring pending migrations |
| [docs-task.ts](../../implementation/src/application/docs-task.ts) | `design release`/`design diff` |
| [test-specs.ts](../../implementation/src/application/test-specs.ts) | Spec assertion runner (materialized mode) |
| [start-project.ts](../../implementation/src/application/start-project.ts) | Workspace scaffolding |
| [with-task.ts](../../implementation/src/application/with-task.ts) | Harness preset application |
| [translate-task.ts](../../implementation/src/application/translate-task.ts) | Localization use case |

Application code emits output through [ApplicationOutputPort](../../implementation/src/domain/ports/output-port.ts). It never writes directly to `console`/`process.stderr`.

## Infrastructure — `src/infrastructure/`

Concrete adapters and side-effecting components.

- **Adapters**: [adapters/](../../implementation/src/infrastructure/adapters/) — one file per port implementation, all named `create<Adapter>(...)`.
- **Workers**: [runner.ts](../../implementation/src/infrastructure/runner.ts) (cross-spawn), [inline-cli.ts](../../implementation/src/infrastructure/inline-cli.ts), [inline-rundown.ts](../../implementation/src/infrastructure/inline-rundown.ts).
- **Persistence**: [runtime-artifacts.ts](../../implementation/src/infrastructure/runtime-artifacts.ts), [worker-health-store.ts](../../implementation/src/infrastructure/worker-health-store.ts), [verification.ts](../../implementation/src/infrastructure/verification.ts).
- **Misc I/O**: [git.ts](../../implementation/src/infrastructure/git.ts), [hooks.ts](../../implementation/src/infrastructure/hooks.ts), [file-lock.ts](../../implementation/src/infrastructure/file-lock.ts), [planner-io.ts](../../implementation/src/infrastructure/planner-io.ts), [selector.ts](../../implementation/src/infrastructure/selector.ts), [sources.ts](../../implementation/src/infrastructure/sources.ts).

## Presentation — `src/presentation/`

The CLI layer. Translates argv into application options and renders output events.

| File | Role |
|---|---|
| [cli.ts](../../implementation/src/presentation/cli.ts) | Commander command tree |
| [cli-command-actions.ts](../../implementation/src/presentation/cli-command-actions.ts) | Per-command argv → app option translation |
| [cli-options.ts](../../implementation/src/presentation/cli-options.ts) | Shared option parsers (worker pattern, runtime flags) |
| [cli-app-init.ts](../../implementation/src/presentation/cli-app-init.ts) | Per-invocation app construction with config-dir resolution |
| [cli-argv.ts](../../implementation/src/presentation/cli-argv.ts) | argv preprocessing (e.g. `--`-separated worker passthrough) |
| [output-port.ts](../../implementation/src/presentation/output-port.ts) | Concrete renderer for `ApplicationOutputPort` events |
| [logged-output-port.ts](../../implementation/src/presentation/logged-output-port.ts) | Renderer that also persists invocation log |
| [intro.ts](../../implementation/src/presentation/intro.ts), [animation.ts](../../implementation/src/presentation/animation.ts) | Visual affordances |

## What lives where — quick rules

- A function with no side effects → `domain`.
- A function that orchestrates ports → `application`.
- A function that calls Node APIs or spawns processes → `infrastructure`.
- A function that touches `process.argv`/`process.stdout` → `presentation`.
