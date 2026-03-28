/**
 * Verification system.
 *
 * Executes task verification and persists parsed verification results.
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
import type { RuntimeArtifactsContext } from "./runtime-artifacts.js";

interface VerificationResult {
  ok: boolean;
  sidecarContent: string;
}

function parseVerificationResult(output: { exitCode: number | null; stdout: string; stderr: string }): VerificationResult {
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();

  if (output.exitCode !== 0) {
    const reason = stdout || stderr || `Verification worker exited with code ${String(output.exitCode)}.`;
    return { ok: false, sidecarContent: reason };
  }

  if (stdout.toUpperCase() === "OK") {
    return { ok: true, sidecarContent: "OK" };
  }

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

  if (stderr !== "") {
    return { ok: false, sidecarContent: stderr };
  }

  return {
    ok: false,
    sidecarContent: "Verification worker returned empty output. Expected OK or a short failure reason.",
  };
}

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
  templateVars?: ExtraTemplateVars;
  artifactContext?: RuntimeArtifactsContext;
}

/**
 * Run the verification step:
 * render the verify template, execute the verifier command,
 * parse worker output, and persist a deterministic sidecar result.
 */
export async function verify(options: VerifyOptions): Promise<boolean> {
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

  const prompt = renderTemplate(options.template, vars);

  options.verificationStore.remove(options.task);

  const runResult = await runWorker({
    command: options.command,
    prompt,
    mode: options.mode ?? "wait",
    transport: options.transport ?? "file",
    trace: options.trace,
    cwd: options.cwd,
    artifactContext: options.artifactContext,
    artifactPhase: "verify",
  });

  const result = parseVerificationResult(runResult);
  options.verificationStore.write(options.task, result.sidecarContent);
  return result.ok;
}
