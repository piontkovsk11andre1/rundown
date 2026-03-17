/**
 * Validation system.
 *
 * Manages task-specific validation sidecar files and evaluates results.
 */

import fs from "node:fs";
import path from "node:path";
import type { Task } from "./parser.js";
import { renderTemplate, type TemplateVars } from "./template.js";
import type { ExtraTemplateVars } from "./template-vars.js";
import { runWorker, type RunnerMode, type PromptTransport } from "./runner.js";

/**
 * Build the validation sidecar file path for a given task.
 *
 * Format: <source-file>.<task-index>.validation
 * Example: Tasks.md.3.validation
 */
export function validationFilePath(task: Task): string {
  return `${task.file}.${task.index}.validation`;
}

/**
 * Read the validation sidecar file content.
 * Returns null if the file does not exist.
 */
export function readValidationFile(task: Task): string | null {
  const p = validationFilePath(task);
  try {
    return fs.readFileSync(p, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Remove the validation sidecar file.
 */
export function removeValidationFile(task: Task): void {
  const p = validationFilePath(task);
  try {
    fs.unlinkSync(p);
  } catch {
    // Ignore if already gone
  }
}

/**
 * Check whether the validation file indicates success.
 */
export function isValidationOk(task: Task): boolean {
  const content = readValidationFile(task);
  return content !== null && content.toUpperCase() === "OK";
}

export interface ValidateOptions {
  task: Task;
  source: string;
  contextBefore: string;
  template: string;
  command: string[];
  mode?: RunnerMode;
  transport?: PromptTransport;
  cwd?: string;
  templateVars?: ExtraTemplateVars;
}

/**
 * Run the validation step:
 * render the validate template, execute the validator command,
 * then check the sidecar file.
 */
export async function validate(options: ValidateOptions): Promise<boolean> {
  const vars: TemplateVars = {
    ...options.templateVars,
    task: options.task.text,
    file: options.task.file,
    context: options.contextBefore,
    taskIndex: options.task.index,
    taskLine: options.task.line,
    source: options.source,
  };

  const prompt = renderTemplate(options.template, vars);

  await runWorker({
    command: options.command,
    prompt,
    mode: options.mode ?? "wait",
    transport: options.transport ?? "file",
    cwd: options.cwd,
  });

  return isValidationOk(options.task);
}
