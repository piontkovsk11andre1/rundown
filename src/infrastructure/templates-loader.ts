/**
 * Template loader.
 *
 * Loads project-local templates from .md-todo/ or falls back to built-in defaults.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VALIDATE_TEMPLATE,
  DEFAULT_CORRECT_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
} from "../domain/defaults.js";

export interface ProjectTemplates {
  task: string;
  validate: string;
  correct: string;
  plan: string;
}

const CONFIG_DIR = ".md-todo";

/**
 * Load templates from the project directory, falling back to built-in defaults.
 *
 * Template names:
 *   .md-todo/execute.md
 *   .md-todo/verify.md
 *   .md-todo/repair.md
 *   .md-todo/plan.md
 */
export function loadProjectTemplates(cwd: string = process.cwd()): ProjectTemplates {
  const dir = path.join(cwd, CONFIG_DIR);

  return {
    task: loadFile(path.join(dir, "execute.md")) ?? DEFAULT_TASK_TEMPLATE,
    validate: loadFile(path.join(dir, "verify.md")) ?? DEFAULT_VALIDATE_TEMPLATE,
    correct: loadFile(path.join(dir, "repair.md")) ?? DEFAULT_CORRECT_TEMPLATE,
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
