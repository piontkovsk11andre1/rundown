/**
 * Verification system.
 *
 * Executes task verification and persists parsed verification results.
 */

import type { Task } from "../domain/parser.js";
import type { VerificationStore } from "../domain/ports/verification-store.js";
import type { CommandExecutionOptions, CommandExecutor } from "../domain/ports/command-executor.js";
import type { TraceWriterPort } from "../domain/ports/trace-writer-port.js";
import { expandCliBlocks } from "../domain/cli-block.js";
import {
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import { runWorker, type RunnerMode } from "./runner.js";
import type { RuntimeArtifactsContext } from "./runtime-artifacts.js";
import { createCliBlockExecutor } from "./cli-block-executor.js";

interface VerificationResult {
  ok: boolean;
  sidecarContent: string;
  formatWarning?: string;
  stdout?: string;
}

export interface ResolveResult {
  resolved: boolean;
  diagnosis: string | null;
}

/**
 * Strip surrounding backticks from a verdict line.
 *
 * Models frequently wrap their output in backticks when the prompt shows
 * backtick-formatted examples, for example `` `OK` `` instead of `OK`.
 */
function stripBackticks(line: string): string {
  return line.startsWith("`") && line.endsWith("`")
    ? line.slice(1, -1)
    : line;
}

/**
 * Extract the last non-empty line from trimmed stdout, returning both the
 * cleaned verdict line and whether preceding output (preamble) was present.
 */
function extractVerdictLine(stdout: string): { verdict: string; hasPreamble: boolean } {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { verdict: "", hasPreamble: false };
  }

  return { verdict: stripBackticks(lines.at(-1)!), hasPreamble: lines.length > 1 };
}

/**
 * Extract the last standalone verification protocol verdict from stdout.
 *
 * Trace mode can append a fenced trace block after the verifier's verdict, and
 * some workers emit preamble before it. Treat only standalone `OK` or `NOT_OK:`
 * lines as protocol verdicts so incidental text does not create false passes.
 */
function extractProtocolVerdict(stdout: string): { verdict: string; hasExtraOutput: boolean } {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  let verdictIndex = -1;
  let verdict = "";

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = stripBackticks(lines[index]!);
    if (candidate.toUpperCase() === "OK" || /^NOT_OK\s*:/i.test(candidate)) {
      verdictIndex = index;
      verdict = candidate;
      break;
    }
  }

  return {
    verdict,
    hasExtraOutput: verdictIndex !== -1 && lines.length > 1,
  };
}

/**
 * Parse resolve worker stdout into a structured diagnosis verdict.
 *
 * Accepts either:
 * - `RESOLVED: <diagnosis>`
 * - `UNRESOLVED: <reason>`
 *
 * The last non-empty line is treated as authoritative so preamble chatter
 * does not break parsing. Malformed output is downgraded into an unresolved
 * result with an explicit parser failure reason.
 */
export function parseResolveResult(stdout: string): ResolveResult {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return {
      resolved: false,
      diagnosis: "Resolve worker returned empty output. Expected RESOLVED: <diagnosis> or UNRESOLVED: <reason>.",
    };
  }

  const { verdict } = extractVerdictLine(trimmedStdout);
  const resolvedPrefix = /^RESOLVED\s*:\s*/i;
  if (resolvedPrefix.test(verdict)) {
    const diagnosis = verdict.replace(resolvedPrefix, "").trim();
    if (diagnosis.length === 0) {
      return {
        resolved: false,
        diagnosis: "Resolve worker returned malformed output: RESOLVED verdict is missing a diagnosis.",
      };
    }

    return {
      resolved: true,
      diagnosis,
    };
  }

  const unresolvedPrefix = /^UNRESOLVED\s*:\s*/i;
  if (unresolvedPrefix.test(verdict)) {
    const reason = verdict.replace(unresolvedPrefix, "").trim();
    if (reason.length === 0) {
      return {
        resolved: false,
        diagnosis: "Resolve worker returned malformed output: UNRESOLVED verdict is missing a reason.",
      };
    }

    return {
      resolved: false,
      diagnosis: reason,
    };
  }

  return {
    resolved: false,
    diagnosis: "Resolve worker returned malformed output. Expected RESOLVED: <diagnosis> or UNRESOLVED: <reason> on the final non-empty line.",
  };
}

/**
 * Extracts validator-centric failure details while excluding assistant chatter.
 *
 * For multi-line output, prefer canonical diff hunks when present; otherwise
 * keep only the final non-empty line as the actionable failure reason.
 */
function extractFailureDetails(stdout: string): string {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }

  const hasDiffHeader = lines.some((line) => /^(diff --git|---\s|\+\+\+\s|@@\s)/.test(line));
  const diffLikeLines = hasDiffHeader
    ? lines.filter((line) => /^(diff --git|---\s|\+\+\+\s|@@\s|[-+])/.test(line))
    : [];
  if (diffLikeLines.length >= 2) {
    return diffLikeLines.join("\n");
  }

  return stripBackticks(lines.at(-1)!);
}

const FORMAT_WARNING = "Verification worker produced extra output around the verdict. Only the protocol verdict line was used. Reinforce output format in your verify prompt.";

/**
 * Normalize worker output into the canonical verification result shape.
 *
 * Accepts explicit success output (`OK`) and various failure formats,
 * then returns a deterministic payload for sidecar persistence.
 *
 * The verdict is extracted from the last standalone protocol line in stdout so
 * that models which emit preamble text before the verdict, or trace output
 * after it, are handled gracefully. When extra output is detected the result
 * carries a `formatWarning` so callers can surface it.
 */
function parseVerificationResult(output: { exitCode: number | null; stdout: string; stderr: string }): VerificationResult {
  const rawStdout = output.stdout;
  // Trim streams once so later checks can treat empty output consistently.
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();

  // Non-zero exit means the worker failed before producing a valid OK payload.
  if (output.exitCode !== 0) {
    const reason = stdout || stderr || `Verification worker exited with code ${String(output.exitCode)}.`;
    return { ok: false, sidecarContent: reason, stdout: rawStdout };
  }

  // Extract the last standalone protocol verdict, ignoring preamble/trace text.
  const { verdict, hasExtraOutput } = extractProtocolVerdict(stdout);
  const formatWarning = hasExtraOutput ? FORMAT_WARNING : undefined;

  // `OK` is the only accepted success token.
  if (verdict.toUpperCase() === "OK") {
    return { ok: true, sidecarContent: "OK", formatWarning, stdout: rawStdout };
  }

  // `NOT_OK: <reason>` is the canonical failure format.
  const notOkPrefix = /^NOT_OK\s*:\s*/i;
  if (notOkPrefix.test(verdict)) {
    const normalizedReason = verdict.replace(notOkPrefix, "").trim();
    return {
      ok: false,
      sidecarContent: normalizedReason === ""
        ? "Verification failed (no details)."
        : normalizedReason,
      formatWarning,
      stdout: rawStdout,
    };
  }

  // Any other non-empty stdout is treated as a human-readable failure reason.
  if (stdout !== "") {
    const normalizedReason = extractFailureDetails(stdout).replace(notOkPrefix, "").trim();
    return {
      ok: false,
      sidecarContent: normalizedReason === ""
        ? "Verification failed (no details)."
        : normalizedReason,
      stdout: rawStdout,
    };
  }

  // Fall back to stderr when stdout is empty.
  if (stderr !== "") {
    return { ok: false, sidecarContent: stderr, stdout: rawStdout };
  }

  // Guard against empty worker output to keep sidecar diagnostics explicit.
  return {
    ok: false,
    sidecarContent: "Verification worker returned empty output. Expected OK or a short failure reason.",
    stdout: rawStdout,
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
  workerPattern: ParsedWorkerPattern;
  verificationStore: VerificationStore;
  mode?: RunnerMode;
  onWorkerOutput?: (stdout: string, stderr: string) => void;
  trace?: boolean;
  traceWriter?: TraceWriterPort;
  cwd?: string;
  configDir?: string;
  templateVars?: ExtraTemplateVars;
  executionEnv?: Record<string, string>;
  artifactContext?: RuntimeArtifactsContext;
  artifactPhaseLabel?: string;
  artifactExtra?: Record<string, unknown>;
  cliBlockExecutor?: CommandExecutor;
  cliExecutionOptions?: CommandExecutionOptions;
  cliExpansionEnabled?: boolean;
}

/**
 * Result returned by the verification step.
 */
export interface VerifyResult {
  valid: boolean;
  formatWarning?: string;
  stdout?: string;
}

/**
 * Run the verification step:
 * render the verify template, execute the verifier command,
 * parse worker output, and persist a deterministic sidecar result.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
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
      env: {
        ...(options.cliExecutionOptions?.env ?? {}),
        ...(options.executionEnv ?? {}),
      },
      artifactContext: options.artifactContext,
      artifactPhase: "verify" as const,
      artifactPhaseLabel: "cli-verify-template",
      artifactExtra: {
        promptType: "verify-template",
        ...(options.artifactExtra ?? {}),
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
    workerPattern: options.workerPattern,
    prompt,
    mode: options.mode ?? "wait",
    trace: options.trace,
    traceWriter: options.traceWriter,
    cwd: options.cwd,
    configDir: options.configDir,
    artifactContext: options.artifactContext,
    artifactPhase: "verify",
    artifactPhaseLabel: options.artifactPhaseLabel,
    artifactExtra: options.artifactExtra,
    env: options.executionEnv,
  });

  // Persist the normalized sidecar output and return final pass/fail status.
  const rawStdout = runResult.stdout;
  options.onWorkerOutput?.(rawStdout, runResult.stderr);
  const result = parseVerificationResult(runResult);
  options.verificationStore.write(options.task, result.sidecarContent);
  return { valid: result.ok, formatWarning: result.formatWarning, stdout: rawStdout };
}
