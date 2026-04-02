/**
 * Verification system.
 *
 * Executes task verification and persists parsed verification results.
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
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import { runWorker, type RunnerMode, type PromptTransport } from "./runner.js";
import type { RuntimeArtifactsContext } from "./runtime-artifacts.js";
import { createCliBlockExecutor } from "./cli-block-executor.js";

interface VerificationResult {
  ok: boolean;
  sidecarContent: string;
}

/**
 * Normalize worker output into the canonical verification result shape.
 *
 * Accepts explicit success output (`OK`) and various failure formats,
 * then returns a deterministic payload for sidecar persistence.
 */
function parseVerificationResult(output: { exitCode: number | null; stdout: string; stderr: string }): VerificationResult {
  // Trim streams once so later checks can treat empty output consistently.
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();

  // Non-zero exit means the worker failed before producing a valid OK payload.
  if (output.exitCode !== 0) {
    const reason = stdout || stderr || `Verification worker exited with code ${String(output.exitCode)}.`;
    return { ok: false, sidecarContent: reason };
  }

  // `OK` is the only accepted success token.
  if (stdout.toUpperCase() === "OK") {
    return { ok: true, sidecarContent: "OK" };
  }

  // Any stdout content is treated as a human-readable failure reason.
  if (stdout !== "") {
    const notOkPrefix = /^NOT_OK\s*:\s*/i;
    const normalizedReason = stdout.replace(notOkPrefix, "").trim();
    return {
      ok: false,
      sidecarContent: normalizedReason === ""
        ? "Verification failed (no details)."
        : normalizedReason,
    };
  }

  // Fall back to stderr when stdout is empty.
  if (stderr !== "") {
    return { ok: false, sidecarContent: stderr };
  }

  // Guard against empty worker output to keep sidecar diagnostics explicit.
  return {
    ok: false,
    sidecarContent: "Verification worker returned empty output. Expected OK or a short failure reason.",
  };
}

/**
 * Inputs required to execute task verification and store its sidecar result.
 *
 * Includes prompt rendering inputs, worker execution settings, and optional
 * CLI block expansion controls used by infrastructure-level verification.
 */
export interface VerifyOptions {
  task: Task;
  source: string;
  contextBefore: string;
  template: string;
  command: string[];
  verificationStore: VerificationStore;
  mode?: RunnerMode;
  transport?: PromptTransport;
  trace?: boolean;
  cwd?: string;
  configDir?: string;
  templateVars?: ExtraTemplateVars;
  artifactContext?: RuntimeArtifactsContext;
  cliBlockExecutor?: CommandExecutor;
  cliExecutionOptions?: CommandExecutionOptions;
  cliExpansionEnabled?: boolean;
}

/**
 * Run the verification step:
 * render the verify template, execute the verifier command,
 * parse worker output, and persist a deterministic sidecar result.
 */
export async function verify(options: VerifyOptions): Promise<boolean> {
  // Build the template context from task metadata and optional custom variables.
  const vars: TemplateVars = {
    ...options.templateVars,
    task: options.task.text,
    file: options.task.file,
    context: options.contextBefore,
    taskIndex: options.task.index,
    taskLine: options.task.line,
    source: options.source,
    ...buildTaskHierarchyTemplateVars(options.task),
  };

  // Render the verification prompt before optional CLI block expansion.
  const renderedPrompt = renderTemplate(options.template, vars);
  // Pass artifact metadata only when artifact retention is enabled.
  const cliExpansionOptions = options.artifactContext?.keepArtifacts
    ? {
      ...options.cliExecutionOptions,
      artifactContext: options.artifactContext,
      artifactPhase: "verify" as const,
      artifactPhaseLabel: "cli-verify-template",
      artifactExtra: {
        promptType: "verify-template",
        ...(options.cliExecutionOptions?.artifactExtra ?? {}),
      },
    }
    : options.cliExecutionOptions;
  // Expand embedded CLI blocks unless explicitly disabled.
  const prompt = options.cliExpansionEnabled === false
    ? renderedPrompt
    : await expandCliBlocks(
      renderedPrompt,
      options.cliBlockExecutor ?? createCliBlockExecutor(),
      options.cwd ?? process.cwd(),
      cliExpansionOptions,
    );

  // Clear any previous sidecar data to avoid stale verification state.
  options.verificationStore.remove(options.task);

  // Execute the verifier worker with the prepared prompt.
  const runResult = await runWorker({
    command: options.command,
    prompt,
    mode: options.mode ?? "wait",
    transport: options.transport ?? "file",
    trace: options.trace,
    cwd: options.cwd,
    configDir: options.configDir,
    artifactContext: options.artifactContext,
    artifactPhase: "verify",
  });

  // Persist the normalized sidecar output and return final pass/fail status.
  const result = parseVerificationResult(runResult);
  options.verificationStore.write(options.task, result.sidecarContent);
  return result.ok;
}
