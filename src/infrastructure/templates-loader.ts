/**
 * Template loader.
 *
 * Loads project-local templates from .rundown/ or falls back to built-in defaults.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
} from "../domain/defaults.js";

export interface ProjectTemplates {
  // Template used by the execute phase.
  task: string;
  // Template used by the discuss phase.
  discuss: string;
  // Template used by discuss-finished phase.
  discussFinished: string;
  // Template used by the verify phase.
  verify: string;
  // Template used by the repair phase.
  repair: string;
  // Template used by the plan phase.
  plan: string;
  // Template used by the research phase.
  research: string;
  // Template used by the trace phase.
  trace: string;
}

/**
 * Loads phase templates from a project configuration directory.
 *
 * When no configuration directory is provided, this function returns the
 * built-in defaults for every template. When a directory is provided, each
 * template is loaded from `.rundown/*.md` and independently falls back to its
 * default when the file is missing or unreadable.
 *
 * Expected template files:
 * - `.rundown/execute.md`
 * - `.rundown/discuss.md`
 * - `.rundown/discuss-finished.md`
 * - `.rundown/verify.md`
 * - `.rundown/repair.md`
 * - `.rundown/plan.md`
 * - `.rundown/research.md`
 * - `.rundown/trace.md`
 *
 * @param configDir Optional absolute or relative path to the project template directory.
 * @returns The resolved set of templates used by each execution phase.
 */
export function loadProjectTemplates(configDir?: string): ProjectTemplates {
  if (!configDir) {
    // Use only built-in defaults when no project override directory is configured.
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

  return {
    // Resolve each template independently so one missing file does not block others.
    task: loadFile(path.join(configDir, "execute.md")) ?? DEFAULT_TASK_TEMPLATE,
    discuss: loadFile(path.join(configDir, "discuss.md")) ?? DEFAULT_DISCUSS_TEMPLATE,
    discussFinished:
      loadFile(path.join(configDir, "discuss-finished.md")) ??
      DEFAULT_DISCUSS_FINISHED_TEMPLATE,
    verify: loadFile(path.join(configDir, "verify.md")) ?? DEFAULT_VERIFY_TEMPLATE,
    repair: loadFile(path.join(configDir, "repair.md")) ?? DEFAULT_REPAIR_TEMPLATE,
    plan: loadFile(path.join(configDir, "plan.md")) ?? DEFAULT_PLAN_TEMPLATE,
    research: loadFile(path.join(configDir, "research.md")) ?? DEFAULT_RESEARCH_TEMPLATE,
    trace: loadFile(path.join(configDir, "trace.md")) ?? DEFAULT_TRACE_TEMPLATE,
  };
}

/**
 * Reads a UTF-8 file and returns `null` when it cannot be read.
 *
 * This helper intentionally swallows read errors because callers always provide
 * a safe fallback template.
 *
 * @param filePath Path to the template file.
 * @returns File contents when readable; otherwise `null`.
 */
function loadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    // Missing or unreadable files are expected in projects without overrides.
    return null;
  }
}
