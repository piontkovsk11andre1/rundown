import {
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../domain/defaults.js";
import type {
  ConfigDirResult,
  PathOperationsPort,
  TemplateLoader,
} from "../domain/ports/index.js";

/**
 * Represents the full set of prompt templates used by application workflows.
 *
 * Each property maps to a specific command mode and contains either a
 * project-provided override or the corresponding built-in default template.
 */
export interface ProjectTemplates {
  task: string;
  discuss: string;
  discussFinished: string;
  verify: string;
  repair: string;
  plan: string;
  research: string;
  trace: string;
}

/**
 * Loads project-level prompt templates from the configured directory when available.
 *
 * Falls back to built-in default templates for any missing file and for cases where
 * project configuration is not enabled.
 */
export function loadProjectTemplatesFromPorts(
  configDir: ConfigDirResult | undefined,
  templateLoader: TemplateLoader,
  pathOperations: PathOperationsPort,
): ProjectTemplates {
  // Use only built-in defaults when no project config directory is available.
  if (!configDir) {
    return {
      task: DEFAULT_TASK_TEMPLATE,
      discuss: DEFAULT_DISCUSS_TEMPLATE,
      discussFinished: DEFAULT_DISCUSS_FINISHED_TEMPLATE,
      verify: DEFAULT_VERIFY_TEMPLATE,
      repair: DEFAULT_REPAIR_TEMPLATE,
      plan: DEFAULT_PLAN_TEMPLATE,
      research: DEFAULT_RESEARCH_TEMPLATE,
      trace: DEFAULT_TRACE_TEMPLATE,
    };
  }

  // Resolve template paths relative to the discovered project config directory.
  const dir = configDir.configDir;
  return {
    // Prefer project overrides, then fall back to bundled default templates.
    task: templateLoader.load(pathOperations.join(dir, "execute.md")) ?? DEFAULT_TASK_TEMPLATE,
    discuss: templateLoader.load(pathOperations.join(dir, "discuss.md")) ?? DEFAULT_DISCUSS_TEMPLATE,
    discussFinished:
      templateLoader.load(pathOperations.join(dir, "discuss-finished.md")) ??
      DEFAULT_DISCUSS_FINISHED_TEMPLATE,
    verify: templateLoader.load(pathOperations.join(dir, "verify.md")) ?? DEFAULT_VERIFY_TEMPLATE,
    repair: templateLoader.load(pathOperations.join(dir, "repair.md")) ?? DEFAULT_REPAIR_TEMPLATE,
    plan: templateLoader.load(pathOperations.join(dir, "plan.md")) ?? DEFAULT_PLAN_TEMPLATE,
    research: templateLoader.load(pathOperations.join(dir, "research.md")) ?? DEFAULT_RESEARCH_TEMPLATE,
    trace: templateLoader.load(pathOperations.join(dir, "trace.md")) ?? DEFAULT_TRACE_TEMPLATE,
  };
}
