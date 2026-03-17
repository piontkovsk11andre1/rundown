/**
 * md-todo — Markdown-native task runtime.
 *
 * Public API surface for programmatic usage.
 */

export { parseTasks, type Task } from "./parser.js";
export { resolveSources } from "./sources.js";
export { selectNextTask } from "./selector.js";
export { renderTemplate, type TemplateVars } from "./template.js";
export { runWorker, type RunnerMode } from "./runner.js";
export { validate, readValidationFile, removeValidationFile } from "./validation.js";
export { correct } from "./correction.js";
export { executeInlineCli } from "./inline-cli.js";
export { checkTask } from "./checkbox.js";
export { loadProjectTemplates, type ProjectTemplates } from "./templates-loader.js";
