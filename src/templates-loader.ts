/**
 * Template loader.
 *
 * Loads project-local templates from .md-todo/ or falls back to built-in defaults.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TASK_TEMPLATE, DEFAULT_VALIDATE_TEMPLATE, DEFAULT_CORRECT_TEMPLATE } from "./defaults.js";

export interface ProjectTemplates {
  task: string;
  validate: string;
  correct: string;
}

const CONFIG_DIR = ".md-todo";

/**
 * Load templates from the project directory, falling back to built-in defaults.
 *
 * Looks for:
 *   .md-todo/task.md
 *   .md-todo/validate.md
 *   .md-todo/correct.md
 */
export function loadProjectTemplates(cwd: string = process.cwd()): ProjectTemplates {
  const dir = path.join(cwd, CONFIG_DIR);

  return {
    task: loadFile(path.join(dir, "task.md")) ?? DEFAULT_TASK_TEMPLATE,
    validate: loadFile(path.join(dir, "validate.md")) ?? DEFAULT_VALIDATE_TEMPLATE,
    correct: loadFile(path.join(dir, "correct.md")) ?? DEFAULT_CORRECT_TEMPLATE,
  };
}

function loadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
