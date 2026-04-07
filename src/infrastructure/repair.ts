/**
 * Auto-repair loop.
 *
 * Runs the repair worker, then re-verifies. Repeats up to a maximum number of attempts.
 */

import type { Task } from "../domain/parser.js";
import type { VerificationStore } from "../domain/ports/verification-store.js";
import type { CommandExecutionOptions, CommandExecutor } from "../domain/ports/command-executor.js";
import { expandCliBlocks } from "../domain/cli-block.js";
import {
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import { runWorker, type RunnerMode } from "./runner.js";
import { verify } from "./verification.js";
import type { RuntimeArtifactsContext } from "./runtime-artifacts.js";
import { createCliBlockExecutor } from "./cli-block-executor.js";

export interface RepairOptions {
  /** Parsed task metadata for the currently selected TODO item. */
  task: Task;
  /** Full source markdown document that contains the TODO list. */
  source: string;
  /** Markdown content before the selected task, used as prompt context. */
  contextBefore: string;
  /** Prompt template used to ask the worker to apply a repair. */
  repairTemplate: string;
  /** Prompt template used to re-run verification after each repair. */
  verifyTemplate: string;
  /** Parsed worker pattern used for repair and verification runs. */
  workerPattern: ParsedWorkerPattern;
  /** Maximum number of repair attempts before failing the loop. */
  maxRetries: number;
  /** Store used to read/write verification outcomes between attempts. */
  verificationStore: VerificationStore;
  /** Optional worker run mode override. */
  mode?: RunnerMode;
  /** Optional callback invoked with raw worker stdout/stderr after each repair run. */
  onWorkerOutput?: (stdout: string, stderr: string) => void;
  /** Enables verbose worker diagnostics when true. */
  trace?: boolean;
  /** Working directory for worker and CLI block execution. */
  cwd?: string;
  /** Optional config directory passed to the worker process. */
  configDir?: string;
  /** Additional template variables merged into repair and verify prompts. */
  templateVars?: ExtraTemplateVars;
  executionEnv?: Record<string, string>;
  /** Runtime artifact context used to capture phase outputs. */
  artifactContext?: RuntimeArtifactsContext;
  /** Optional executor used when expanding CLI blocks in prompts. */
  cliBlockExecutor?: CommandExecutor;
  /** Options forwarded to CLI block execution during prompt expansion. */
  cliExecutionOptions?: CommandExecutionOptions;
  /** Disables CLI block expansion when explicitly set to false. */
  cliExpansionEnabled?: boolean;
}

/**
 * Represents the final state of the repair loop.
 *
 * The result indicates whether verification ever passed and how many repair
 * attempts were consumed before termination.
 */
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

  // Retry until verification succeeds or the configured attempt limit is reached.
  for (let i = 0; i < options.maxRetries; i++) {
    attempts++;

    // Use the last verification output to guide the next repair prompt.
    const verificationResult = options.verificationStore.read(options.task) ?? "Verification failed (no details).";

    // Build template variables from task metadata and the latest verification result.
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

    // Render the repair prompt and expand inline CLI blocks when enabled.
    const renderedPrompt = renderTemplate(options.repairTemplate, vars);
    const cliExpansionOptions = options.artifactContext?.keepArtifacts
      ? {
        ...options.cliExecutionOptions,
        env: {
          ...(options.cliExecutionOptions?.env ?? {}),
          ...(options.executionEnv ?? {}),
        },
        artifactContext: options.artifactContext,
        artifactPhase: "repair" as const,
        artifactPhaseLabel: "cli-repair-template",
        artifactExtra: {
          promptType: "repair-template",
          attempt: attempts,
          ...(options.cliExecutionOptions?.artifactExtra ?? {}),
        },
      }
      : options.cliExecutionOptions;
    const prompt = options.cliExpansionEnabled === false
      ? renderedPrompt
      : await expandCliBlocks(
        renderedPrompt,
        options.cliBlockExecutor ?? createCliBlockExecutor(),
        options.cwd ?? process.cwd(),
        cliExpansionOptions,
      );

    // Execute one repair attempt with the prepared prompt.
    const runResult = await runWorker({
      workerPattern: options.workerPattern,
      prompt,
      mode: options.mode ?? "wait",
      trace: options.trace,
      cwd: options.cwd,
      env: options.executionEnv,
      configDir: options.configDir,
      artifactContext: options.artifactContext,
      artifactPhase: "repair",
      artifactExtra: { attempt: attempts },
    });
    options.onWorkerOutput?.(runResult.stdout, runResult.stderr);

    // Re-run verification immediately after each repair attempt.
    const { valid } = await verify({
      task: options.task,
      source: options.source,
      contextBefore: options.contextBefore,
      template: options.verifyTemplate,
      workerPattern: options.workerPattern,
      verificationStore: options.verificationStore,
      mode: options.mode,
      trace: options.trace,
      cwd: options.cwd,
      configDir: options.configDir,
      templateVars: options.templateVars,
      executionEnv: options.executionEnv,
      artifactContext: options.artifactContext,
      cliBlockExecutor: options.cliBlockExecutor,
      cliExecutionOptions: options.cliExecutionOptions,
      cliExpansionEnabled: options.cliExpansionEnabled,
    });

    // Exit early as soon as verification passes.
    if (valid) {
      return { valid: true, attempts };
    }
  }

  // Exhausted all retries without reaching a valid state.
  return { valid: false, attempts };
}
