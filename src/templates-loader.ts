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
} from "./defaults.js";

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
 * Primary names:
 *   .md-todo/execute.md
 *   .md-todo/verify.md
 *   .md-todo/repair.md
 *   .md-todo/plan.md
 *
 * Backward-compatible aliases:
 *   .md-todo/task.md
 *   .md-todo/validate.md
 *   .md-todo/correct.md
 */
export function loadProjectTemplates(cwd: string = process.cwd()): ProjectTemplates {
  const dir = path.join(cwd, CONFIG_DIR);

  return {
    task: loadFirstAvailable(
      path.join(dir, "execute.md"),
      path.join(dir, "task.md"),
    ) ?? DEFAULT_TASK_TEMPLATE,
    validate: loadFirstAvailable(
      path.join(dir, "verify.md"),
      path.join(dir, "validate.md"),
    ) ?? DEFAULT_VALIDATE_TEMPLATE,
    correct: loadFirstAvailable(
      path.join(dir, "repair.md"),
      path.join(dir, "correct.md"),
    ) ?? DEFAULT_CORRECT_TEMPLATE,
    plan: loadFile(path.join(dir, "plan.md")) ?? DEFAULT_PLAN_TEMPLATE,
  };
}

function loadFirstAvailable(...filePaths: string[]): string | null {
  for (const filePath of filePaths) {
    const loaded = loadFile(filePath);
    if (loaded !== null) {
      return loaded;
    }
  }

  return null;
}

function loadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
