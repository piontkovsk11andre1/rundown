/**
 * Auto-repair loop.
 *
 * Runs the repair worker, then re-verifies. Repeats up to a maximum number of attempts.
 */

import type { Task } from "../domain/parser.js";
import type { VerificationStore } from "../domain/ports/verification-store.js";
import {
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import { runWorker, type RunnerMode, type PromptTransport } from "./runner.js";
import { verify } from "./verification.js";
import type { RuntimeArtifactsContext } from "./runtime-artifacts.js";

export interface RepairOptions {
  task: Task;
  source: string;
  contextBefore: string;
  repairTemplate: string;
  verifyTemplate: string;
  command: string[];
  maxRetries: number;
  verificationStore: VerificationStore;
  mode?: RunnerMode;
  transport?: PromptTransport;
  trace?: boolean;
  cwd?: string;
  templateVars?: ExtraTemplateVars;
  artifactContext?: RuntimeArtifactsContext;
}

export interface RepairResult {
  /** Whether verification eventually passed. */
  valid: boolean;
  /** How many correction attempts were made. */
  attempts: number;
}

/**
 * Run the repair loop.
 *
 * For each attempt:
 * 1. Render the repair template (including previous verification result).
 * 2. Run the repair command.
 * 3. Re-verify.
 * 4. If valid, stop. Otherwise, retry up to maxRetries.
 */
export async function repair(options: RepairOptions): Promise<RepairResult> {
  let attempts = 0;

  for (let i = 0; i < options.maxRetries; i++) {
    attempts++;

    // Read current verification failure reason
    const verificationResult = options.verificationStore.read(options.task) ?? "Verification failed (no details).";

    const vars: TemplateVars = {
      ...options.templateVars,
      task: options.task.text,
      file: options.task.file,
      context: options.contextBefore,
      taskIndex: options.task.index,
      taskLine: options.task.line,
      source: options.source,
      verificationResult,
      ...buildTaskHierarchyTemplateVars(options.task),
    };

    const prompt = renderTemplate(options.repairTemplate, vars);

    // Run repair worker
    await runWorker({
      command: options.command,
      prompt,
      mode: options.mode ?? "wait",
      transport: options.transport ?? "file",
      trace: options.trace,
      cwd: options.cwd,
      artifactContext: options.artifactContext,
      artifactPhase: "repair",
      artifactExtra: { attempt: attempts },
    });

    // Re-verify
    const valid = await verify({
      task: options.task,
      source: options.source,
      contextBefore: options.contextBefore,
      template: options.verifyTemplate,
      command: options.command,
      verificationStore: options.verificationStore,
      mode: options.mode,
      transport: options.transport,
      trace: options.trace,
      cwd: options.cwd,
      templateVars: options.templateVars,
      artifactContext: options.artifactContext,
    });

    if (valid) {
      return { valid: true, attempts };
    }
  }

  return { valid: false, attempts };
}
