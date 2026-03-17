/**
 * Auto-correction loop.
 *
 * Runs the corrector, then re-validates. Repeats up to a maximum number of attempts.
 */

import type { Task } from "./parser.js";
import { renderTemplate, type TemplateVars } from "./template.js";
import type { ExtraTemplateVars } from "./template-vars.js";
import { runWorker, type RunnerMode, type PromptTransport } from "./runner.js";
import { validate, readValidationFile, type ValidateOptions } from "./validation.js";

export interface CorrectionOptions {
  task: Task;
  source: string;
  contextBefore: string;
  correctTemplate: string;
  validateTemplate: string;
  command: string[];
  maxRetries: number;
  mode?: RunnerMode;
  transport?: PromptTransport;
  cwd?: string;
  templateVars?: ExtraTemplateVars;
}

export interface CorrectionResult {
  /** Whether validation eventually passed. */
  valid: boolean;
  /** How many correction attempts were made. */
  attempts: number;
}

/**
 * Run the correction loop.
 *
 * For each attempt:
 * 1. Render the correction template (including previous validation result).
 * 2. Run the corrector command.
 * 3. Re-validate.
 * 4. If valid, stop. Otherwise, retry up to maxRetries.
 */
export async function correct(options: CorrectionOptions): Promise<CorrectionResult> {
  let attempts = 0;

  for (let i = 0; i < options.maxRetries; i++) {
    attempts++;

    // Read current validation failure reason
    const validationResult = readValidationFile(options.task) ?? "Validation failed (no details).";

    const vars: TemplateVars = {
      ...options.templateVars,
      task: options.task.text,
      file: options.task.file,
      context: options.contextBefore,
      taskIndex: options.task.index,
      taskLine: options.task.line,
      source: options.source,
      validationResult,
    };

    const prompt = renderTemplate(options.correctTemplate, vars);

    // Run corrector
    await runWorker({
      command: options.command,
      prompt,
      mode: options.mode ?? "wait",
      transport: options.transport ?? "file",
      cwd: options.cwd,
    });

    // Re-validate
    const valid = await validate({
      task: options.task,
      source: options.source,
      contextBefore: options.contextBefore,
      template: options.validateTemplate,
      command: options.command,
      mode: options.mode,
      transport: options.transport,
      cwd: options.cwd,
      templateVars: options.templateVars,
    });

    if (valid) {
      return { valid: true, attempts };
    }
  }

  return { valid: false, attempts };
}
