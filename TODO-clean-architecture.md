# Clean Architecture Migration — Phase 1

## Reference Data

### Decisions

- **Scope:** Conservative — folder structure + extract use cases from cli.ts. No port interfaces yet (Phase 2).
- **DI style:** Lightweight composition root (`createApp()` factory).
- **Folders:** By layer — `domain/`, `application/`, `infrastructure/`, `presentation/`.
- **Tests:** Mirror structure in `__tests__/` folder.

### Build Config

**tsup.config.ts** — two entry points:
- `{ entry: { cli: "src/cli.ts" } }` → `dist/cli.js` (ESM, with `#!/usr/bin/env node` banner)
- `{ entry: { index: "src/index.ts" } }` → `dist/index.js` (ESM, dts: true)

After migration:
- CLI entry becomes `src/presentation/cli.ts`
- Library entry stays `src/index.ts` (re-exports from new paths)

**vitest.config.ts** — `include: ["src/**/*.test.ts"]`
After migration: `include: ["__tests__/**/*.test.ts"]`

**tsconfig.json** — `rootDir: "src"`, `include: ["src"]`, `exclude: [..., "**/*.test.ts"]`
After migration: keep same (tests already excluded, source stays under `src/`)

**package.json** — `bin: { "md-todo": "./dist/cli.js" }`, `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`
After migration: unchanged (tsup entry config controls output filenames)

### File Classification & Target Layer

| Current File | Target Layer | Target Path | Notes |
|---|---|---|---|
| `parser.ts` | domain | `domain/parser.ts` | Pure. No changes. |
| `template.ts` | domain | `domain/template.ts` | Pure. No changes. |
| `defaults.ts` | domain | `domain/defaults.ts` | Pure. No changes. |
| `run-options.ts` | domain | `domain/run-options.ts` | Pure. No changes. |
| `sorting.ts` | domain | `domain/sorting.ts` | Has `fs.statSync` in `birthtime()`. Move as-is, extract I/O in Phase 2. |
| `checkbox.ts` | split | `domain/checkbox.ts` (pure `markChecked`) + `infrastructure/checkbox-io.ts` (I/O `checkTask`) | |
| `planner.ts` | split | `domain/planner.ts` (pure `parsePlannerOutput`, `computeChildIndent`, `insertSubitems`) + `infrastructure/planner-io.ts` (I/O `applyPlannerOutput`) | |
| `template-vars.ts` | split | `domain/template-vars.ts` (pure `parseCliTemplateVars`, `ExtraTemplateVars`, `DEFAULT_TEMPLATE_VARS_FILE`, `resolveTemplateVarsFilePath`) + `infrastructure/template-vars-io.ts` (I/O `loadTemplateVarsFile`) | |
| `runner.ts` | infrastructure | `infrastructure/runner.ts` | Direct I/O via cross-spawn. |
| `inline-cli.ts` | infrastructure | `infrastructure/inline-cli.ts` | Direct I/O via child_process. |
| `git.ts` | infrastructure | `infrastructure/git.ts` | Direct I/O via child_process. |
| `hooks.ts` | infrastructure | `infrastructure/hooks.ts` | Direct I/O via child_process. |
| `runtime-artifacts.ts` | infrastructure | `infrastructure/runtime-artifacts.ts` | Heavy fs + crypto. |
| `templates-loader.ts` | infrastructure | `infrastructure/templates-loader.ts` | Reads fs. |
| `sources.ts` | infrastructure | `infrastructure/sources.ts` | fs + fast-glob. |
| `selector.ts` | infrastructure | `infrastructure/selector.ts` | fs.readFileSync in selectNextTask. Pure `filterRunnable`/`hasUncheckedDescendants` stay here, extract in Phase 2. |
| `validation.ts` | infrastructure | `infrastructure/validation.ts` | Orchestrates runner + sidecar I/O. |
| `correction.ts` | infrastructure | `infrastructure/correction.ts` | Orchestrates retry loop. |
| `log.ts` | presentation | `presentation/log.ts` | Console output. |
| `cli.ts` | split | `presentation/cli.ts` (Commander setup, arg parsing, thin handlers) + `application/*.ts` (use cases from orchestration logic) | |
| `index.ts` | root | `index.ts` | Update re-export paths. |

### cli.ts Decomposition Map

cli.ts is 1085 lines. Extract these use cases:

| Use Case | Source in cli.ts | Target File | Key Logic |
|---|---|---|---|
| `runTask` | `run` command L88–L376 + `runValidation` L779–L844 + `afterTaskComplete` L845–L900 + helpers | `application/run-task.ts` | Source resolve → select → render → execute → validate → correct → check → git → hooks |
| `planTask` | `plan` command L555–L739 | `application/plan-task.ts` | Source resolve → select → render plan template → run worker → apply planner output |
| `listTasks` | `list` command L408–L452 | `application/list-tasks.ts` | Source resolve → parse → filter → format |
| `nextTask` | `next` command L377–L407 | `application/next-task.ts` | Source resolve → select → display |
| `initProject` | `init` command L740–L778 | `application/init-project.ts` | Scaffold `.md-todo/` with defaults |
| `manageArtifacts` | `artifacts` command L453–L554 | `application/manage-artifacts.ts` | List/show/clean runtime artifacts |

Helpers that stay in `presentation/cli.ts`: `parseCliArgs`, `readCliVersion`, `collectOption`, `parseRunnerMode`, `parsePromptTransport`, `parseSortMode`, `parseRetries`, `resolveVerifyFlag`, `splitWorkerFromSeparator`, `terminate`, `isCliExitSignal`, `CliExitSignal`.

Helpers that move to use cases: `runValidation`, `afterTaskComplete`, `getAutomationWorkerCommand`, `finalizeRunArtifacts`, `toRuntimeTaskMetadata`, `isOpenCodeWorkerCommand`.

`openDirectory` → `infrastructure/open-directory.ts` (shells out to OS).

### index.ts Public API — Current Exports (must all remain accessible)

```
parseTasks, Task                                    → from domain/parser
resolveSources                                      → from infrastructure/sources
selectNextTask, selectTaskByLocation,
  hasUncheckedDescendants, filterRunnable            → from infrastructure/selector
renderTemplate, TemplateVars                         → from domain/template
runWorker, RunnerMode                                → from infrastructure/runner
validate, readValidationFile, removeValidationFile   → from infrastructure/validation
correct                                              → from infrastructure/correction
executeInlineCli                                     → from infrastructure/inline-cli
checkTask                                            → from infrastructure/checkbox-io
isGitRepo, commitCheckedTask, CommitTaskOptions       → from infrastructure/git
runOnCompleteHook, OnCompleteHookOptions,
  HookResult, HookTaskInfo                           → from infrastructure/hooks
insertSubitems                                       → from domain/planner
loadProjectTemplates, ProjectTemplates                → from infrastructure/templates-loader
createRuntimeArtifactsContext, displayArtifactsPath,
  findSavedRuntimeArtifact, latestSavedRuntimeArtifact,
  listFailedRuntimeArtifacts, listSavedRuntimeArtifacts,
  removeFailedRuntimeArtifacts, removeSavedRuntimeArtifacts,
  runtimeArtifactsRootDir, isFailedRuntimeArtifactStatus,
  RuntimeArtifactsContext, RuntimeTaskMetadata,
  SavedRuntimeArtifactRun                            → from infrastructure/runtime-artifacts
```

### Test Files — Current → Target

| Current | Target |
|---|---|
| `src/parser.test.ts` | `__tests__/domain/parser.test.ts` |
| `src/checkbox.test.ts` | `__tests__/domain/checkbox.test.ts` + `__tests__/infrastructure/checkbox-io.test.ts` |
| `src/defaults.test.ts` | `__tests__/domain/defaults.test.ts` |
| `src/sorting.test.ts` | `__tests__/domain/sorting.test.ts` |
| `src/template.test.ts` | `__tests__/domain/template.test.ts` |
| `src/template-vars.test.ts` | `__tests__/domain/template-vars.test.ts` + `__tests__/infrastructure/template-vars-io.test.ts` |
| `src/run-options.test.ts` | `__tests__/domain/run-options.test.ts` |
| `src/planner.test.ts` | `__tests__/domain/planner.test.ts` + `__tests__/infrastructure/planner-io.test.ts` |
| `src/selector.test.ts` | `__tests__/infrastructure/selector.test.ts` |
| `src/sources.test.ts` | `__tests__/infrastructure/sources.test.ts` |
| `src/runner.test.ts` | `__tests__/infrastructure/runner.test.ts` |
| `src/validation.test.ts` | `__tests__/infrastructure/validation.test.ts` |
| `src/hooks.test.ts` | `__tests__/infrastructure/hooks.test.ts` |
| `src/git.test.ts` | `__tests__/infrastructure/git.test.ts` |
| `src/templates-loader.test.ts` | `__tests__/infrastructure/templates-loader.test.ts` |
| `src/cli.integration.test.ts` | `__tests__/integration/cli.test.ts` |

### Internal Import Rewiring

When a file moves, every file that imports from it must update its import path. Key cross-layer imports:

- `infrastructure/selector.ts` → `../domain/parser.js`, `../domain/sorting.js`
- `infrastructure/checkbox-io.ts` → `../domain/parser.js`
- `infrastructure/planner-io.ts` → `../domain/parser.js`
- `infrastructure/templates-loader.ts` → `../domain/defaults.js`
- `infrastructure/validation.ts` → `../domain/parser.js`, `../domain/template.js`, `../domain/template-vars.js`, `./runner.js`, `./runtime-artifacts.js`
- `infrastructure/correction.ts` → `../domain/parser.js`, `../domain/template.js`, `../domain/template-vars.js`, `./runner.js`, `./validation.js`, `./runtime-artifacts.js`
- `infrastructure/git.ts` → `../domain/template.js`
- `infrastructure/runner.ts` → `./runtime-artifacts.js`
- `infrastructure/inline-cli.ts` → `./runtime-artifacts.js`
- `presentation/cli.ts` → `../infrastructure/*`, `../domain/*`, `../application/*`, `./log.js`
- `application/*.ts` → `../domain/*`, `../infrastructure/*`, `../presentation/log.js`
- `index.ts` → `./domain/*`, `./infrastructure/*`

---

## TODO

### 1. Create directory structure
- [x] 1.1 Create `src/domain/`
- [x] 1.2 Create `src/application/`
- [x] 1.3 Create `src/infrastructure/`
- [x] 1.4 Create `src/presentation/`
- [x] 1.5 Create `__tests__/domain/`, `__tests__/infrastructure/`, `__tests__/integration/`

### 2. Move pure domain modules (no code changes, only move + update internal imports)
- [x] 2.1 Move `parser.ts` → `domain/parser.ts`
- [x] 2.2 Move `template.ts` → `domain/template.ts`
- [x] 2.3 Move `defaults.ts` → `domain/defaults.ts`
- [x] 2.4 Move `run-options.ts` → `domain/run-options.ts`
- [x] 2.5 Move `sorting.ts` → `domain/sorting.ts`
- [x] 2.6 Move `log.ts` → `presentation/log.ts`

### 3. Split mixed modules into pure domain + I/O infrastructure
- [x] 3.1 Split `checkbox.ts` → `domain/checkbox.ts` (pure `markChecked`, re-export `Task` type) + `infrastructure/checkbox-io.ts` (I/O `checkTask`)
- [x] 3.2 Split `planner.ts` → `domain/planner.ts` (pure `parsePlannerOutput`, `computeChildIndent`, `insertSubitems`) + `infrastructure/planner-io.ts` (I/O `applyPlannerOutput`)
  - [x] Create `src/domain/planner.ts` with `parsePlannerOutput`, `computeChildIndent`, and `insertSubitems` (plus any shared planner types) as pure logic only.
  - [x] Create `src/infrastructure/planner-io.ts` with `applyPlannerOutput`, moving all file I/O there and wiring it to the domain planner helpers.
  - [x] Update all internal imports that currently reference `planner.ts` to use `src/domain/planner.ts` or `src/infrastructure/planner-io.ts` as appropriate.
  - [x] Update `src/index.ts` re-exports so the public API remains correct after the split.
  - [x] Split planner tests into `__tests__/domain/planner.test.ts` (pure functions) and `__tests__/infrastructure/planner-io.test.ts` (I/O behavior), updating imports and mocks.
  - [x] Remove the legacy `src/planner.ts` module once all references are migrated.
  - [x] Run planner-related tests (and typecheck/build if needed) to verify the split is behavior-preserving.
- [x] 3.3 Split `template-vars.ts` → `domain/template-vars.ts` (pure `parseCliTemplateVars`, types, const) + `infrastructure/template-vars-io.ts` (I/O `loadTemplateVarsFile`)

### 4. Move infrastructure modules
- [x] 4.1 Move `runner.ts` → `infrastructure/runner.ts`
- [x] 4.2 Move `inline-cli.ts` → `infrastructure/inline-cli.ts`
- [x] 4.3 Move `git.ts` → `infrastructure/git.ts`
- [x] 4.4 Move `hooks.ts` → `infrastructure/hooks.ts`
- [x] 4.5 Move `runtime-artifacts.ts` → `infrastructure/runtime-artifacts.ts`
- [x] 4.6 Move `templates-loader.ts` → `infrastructure/templates-loader.ts`
- [x] 4.7 Move `sources.ts` → `infrastructure/sources.ts`
- [x] 4.8 Move `selector.ts` → `infrastructure/selector.ts`
- [x] 4.9 Move `validation.ts` → `infrastructure/validation.ts`
- [x] 4.10 Move `correction.ts` → `infrastructure/correction.ts`

### 5. Update all internal imports across moved files
- [x] 5.1 Fix cross-layer imports in infrastructure modules (refer to "Internal Import Rewiring" section)
- [x] 5.2 Fix imports in domain modules (should have zero cross-layer imports)
- [x] 5.3 Verify no circular dependencies exist

### 6. Extract use cases from cli.ts
- [x] 6.1 Extract `application/run-task.ts` — main run loop + `runValidation` + `afterTaskComplete` + helpers (`getAutomationWorkerCommand`, `finalizeRunArtifacts`, `toRuntimeTaskMetadata`, `isOpenCodeWorkerCommand`)
- [x] 6.2 Extract `application/plan-task.ts` — plan command orchestration
- [x] 6.3 Extract `application/list-tasks.ts` — list command logic
- [x] 6.4 Extract `application/next-task.ts` — next command logic
- [x] 6.5 Extract `application/init-project.ts` — init scaffolding
- [x] 6.6 Extract `application/manage-artifacts.ts` — artifacts management (list/show/clean/open)
- [x] 6.7 Extract `infrastructure/open-directory.ts` from `openDirectory` helper

### 7. Create composition root
- [x] 7.1 Create `src/create-app.ts` — `createApp()` factory that wires infrastructure deps into use-case functions
- [x] 7.2 Define the `App` return type shape: `{ runTask, planTask, listTasks, nextTask, initProject, manageArtifacts }`

### 8. Slim down presentation/cli.ts
- [x] 8.1 Move `cli.ts` → `presentation/cli.ts`
- [x] 8.2 Replace inline orchestration with calls to `createApp()` use cases
- [x] 8.3 Keep only: Commander setup, option parsing, `parseCliArgs`, `terminate`, `CliExitSignal`, parse helpers
- [x] 8.4 Verify target is under ~300 lines

### 9. Update index.ts public API
- [x] 9.1 Rewrite all re-export paths to new locations (see "index.ts Public API" section)
- [x] 9.2 Verify every currently exported symbol is still exported

### 10. Move and update tests
- [x] 10.1 Move domain tests to `__tests__/domain/` and update import paths
- [ ] 10.2 Move infrastructure tests to `__tests__/infrastructure/` and update import paths
- [ ] 10.3 Split tests for split modules (checkbox, planner, template-vars) into domain + infrastructure test files
- [ ] 10.4 Move `cli.integration.test.ts` → `__tests__/integration/cli.test.ts` and update imports
- [ ] 10.5 Update `vitest.config.ts` include pattern to `["__tests__/**/*.test.ts"]`

### 11. Update build configuration
- [ ] 11.1 Update `tsup.config.ts` CLI entry to `src/presentation/cli.ts`
- [ ] 11.2 Verify `tsconfig.json` still works (rootDir: "src", include: ["src"])
- [ ] 11.3 Verify `package.json` bin/main/types/exports resolve correctly after build

### 12. Validate
- [ ] 12.1 `npm run lint` — no TypeScript errors
- [ ] 12.2 `npm run test` — all tests pass
- [ ] 12.3 `npm run build` — builds cleanly, dist/ has `cli.js` and `index.js`
- [ ] 12.4 `node dist/cli.js --help` — CLI works
- [ ] 12.5 `npm pack --dry-run` — correct package contents
- [ ] 12.6 Delete any leftover files from old flat `src/` structure

### 13. Cleanup
- [ ] 13.1 Remove empty old test files from `src/` if any remain
- [ ] 13.2 Verify no dead imports or unused files
- [ ] 13.3 Update this TODO — mark Phase 1 complete

---

## Next: Phase 2 — Port Interfaces & Dependency Inversion

After Phase 1 is complete and stable:

- [ ] **14.1** Define port interfaces in `domain/ports/`: `FileSystem`, `ProcessRunner`, `GitClient`, `TemplateLoader`, `ValidationSidecar`, `ArtifactStore`, `Clock`
- [ ] **14.2** Refactor domain modules to depend only on port interfaces (no `fs`, `child_process` imports)
- [ ] **14.3** Extract pure functions from mixed infrastructure modules (`selector.ts` → `filterRunnable`/`hasUncheckedDescendants` to domain; `sorting.ts` → split `birthtime` out)
- [ ] **14.4** Create adapter implementations in `infrastructure/adapters/` (e.g., `fs-file-system.ts`, `crossspawn-process-runner.ts`)
- [ ] **14.5** Update `createApp()` to inject adapters through port interfaces
- [ ] **14.6** Add unit tests with test doubles (in-memory filesystem, mock process runner, etc.)
- [ ] **14.7** Make use cases depend only on `domain/` types + port interfaces (zero infrastructure imports)
