/**
 * md-todo — Markdown-native task runtime.
 *
 * Public API surface for programmatic usage.
 */

export { parseTasks, type Task } from "./domain/parser.js";
export { resolveSources } from "./infrastructure/sources.js";
export {
  selectNextTask,
  selectTaskByLocation,
  hasUncheckedDescendants,
  filterRunnable,
} from "./infrastructure/selector.js";
export { renderTemplate, type TemplateVars } from "./domain/template.js";
export { runWorker, type RunnerMode } from "./infrastructure/runner.js";
export {
  validate,
  readValidationFile,
  removeValidationFile,
} from "./infrastructure/validation.js";
export { correct } from "./infrastructure/correction.js";
export { executeInlineCli } from "./infrastructure/inline-cli.js";
export { checkTask } from "./infrastructure/checkbox-io.js";
export {
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
  DEFAULT_TEMPLATE_VARS_FILE,
} from "./domain/template-vars.js";
export { loadTemplateVarsFile } from "./infrastructure/template-vars-io.js";
export { isGitRepo, commitCheckedTask, type CommitTaskOptions } from "./infrastructure/git.js";
export {
  runOnCompleteHook,
  type OnCompleteHookOptions,
  type HookResult,
  type HookTaskInfo,
} from "./infrastructure/hooks.js";
export { insertSubitems } from "./domain/planner.js";
export { loadProjectTemplates, type ProjectTemplates } from "./infrastructure/templates-loader.js";
export {
  createRuntimeArtifactsContext,
  displayArtifactsPath,
  findSavedRuntimeArtifact,
  latestSavedRuntimeArtifact,
  listFailedRuntimeArtifacts,
  listSavedRuntimeArtifacts,
  removeFailedRuntimeArtifacts,
  removeSavedRuntimeArtifacts,
  runtimeArtifactsRootDir,
  isFailedRuntimeArtifactStatus,
  type RuntimeArtifactsContext,
  type RuntimeTaskMetadata,
  type SavedRuntimeArtifactRun,
} from "./infrastructure/runtime-artifacts.js";
