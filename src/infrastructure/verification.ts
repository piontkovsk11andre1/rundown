/**
 * Verification system.
 *
 * Manages task-specific verification sidecar files and evaluates results.
 */

import fs from "node:fs";
import type { Task } from "../domain/parser.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import { runWorker, type RunnerMode, type PromptTransport } from "./runner.js";
import type { RuntimeArtifactsContext } from "./runtime-artifacts.js";

/**
 * Build the verification sidecar file path for a given task.
 *
 * Format: <source-file>.<task-index>.validation
 * Example: Tasks.md.3.validation
 */
export function verificationFilePath(task: Task): string {
  return `${task.file}.${task.index}.validation`;
}

/**
 * Read the verification sidecar file content.
 * Returns null if the file does not exist.
 */
export function readVerificationFile(task: Task): string | null {
  const p = verificationFilePath(task);
  try {
    return fs.readFileSync(p, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Persist verification content for a task.
 */
export function writeVerificationFile(task: Task, content: string): void {
  const p = verificationFilePath(task);
  const normalized = content.trim() === ""
    ? "Verification failed (no details)."
    : content.trim();
  fs.writeFileSync(p, normalized, "utf-8");
}

/**
 * Remove the verification sidecar file.
 */
export function removeVerificationFile(task: Task): void {
  const p = verificationFilePath(task);
  try {
    fs.unlinkSync(p);
  } catch {
    // Ignore if already gone
  }
}

/**
 * Check whether the verification file indicates success.
 */
export function isVerificationOk(task: Task): boolean {
  const content = readVerificationFile(task);
  return content !== null && content.toUpperCase() === "OK";
}

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
  mode?: RunnerMode;
  transport?: PromptTransport;
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
  };

  const prompt = renderTemplate(options.template, vars);

  removeVerificationFile(options.task);

  const runResult = await runWorker({
    command: options.command,
    prompt,
    mode: options.mode ?? "wait",
    transport: options.transport ?? "file",
    cwd: options.cwd,
    artifactContext: options.artifactContext,
    artifactPhase: "verify",
  });

  const result = parseVerificationResult(runResult);
  writeVerificationFile(options.task, result.sidecarContent);
  return result.ok;
}
