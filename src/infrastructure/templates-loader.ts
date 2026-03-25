/**
 * Template loader.
 *
 * Loads project-local templates from .rundown/ or falls back to built-in defaults.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
} from "../domain/defaults.js";

export interface ProjectTemplates {
  task: string;
  verify: string;
  repair: string;
  plan: string;
}

const CONFIG_DIR = ".rundown";

/**
 * Load templates from the project directory, falling back to built-in defaults.
 *
 * Template names:
 *   .rundown/execute.md
 *   .rundown/verify.md
 *   .rundown/repair.md
 *   .rundown/plan.md
 */
export function loadProjectTemplates(cwd: string = process.cwd()): ProjectTemplates {
  const dir = path.join(cwd, CONFIG_DIR);

  return {
    task: loadFile(path.join(dir, "execute.md")) ?? DEFAULT_TASK_TEMPLATE,
    verify: loadFile(path.join(dir, "verify.md")) ?? DEFAULT_VERIFY_TEMPLATE,
    repair: loadFile(path.join(dir, "repair.md")) ?? DEFAULT_REPAIR_TEMPLATE,
    plan: loadFile(path.join(dir, "plan.md")) ?? DEFAULT_PLAN_TEMPLATE,
  };
}

function loadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
