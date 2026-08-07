import { type AnalysisSummaryPayload } from "../domain/trace.js";
import { parseWorkerOutput } from "../domain/worker-output-parser.js";
import type {
  ArtifactRunContext,
  FileSystem,
  PathOperationsPort,
} from "../domain/ports/index.js";
import {
  asEnum,
  asNonNegativeInt,
  asStringArray,
  computeDurationMs,
  parseJson,
} from "./run-task-utils.js";

/**
 * Raw metadata schema written per trace phase on disk.
 *
 * This mirrors `metadata.json` and keeps fields permissive so callers can
 * normalize unknown or missing values safely.
 */
export interface TracePhaseMetadata {
  sequence: number;
  phase: string;
  startedAt?: string;
  completedAt?: string;
  command?: string[];
  exitCode?: number | null;
  outputCaptured?: boolean;
  stdoutFile?: string | null;
  stderrFile?: string | null;
}

/**
 * Normalized, in-memory representation of a phase artifact used by formatting
 * and analysis helpers.
 */
export interface TracePhaseArtifact {
  sequence: number;
  phase: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  command: string[];
  exitCode: number | null;
  outputCaptured: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Aggregated parser output collected across all recorded phases.
 */
export interface PhaseAnalysisSummary {
  signals: Array<{ phase: string; sequence: number; values: Record<string, string> }>;
  thinkingBlocks: Array<{ phase: string; sequence: number; content: string }>;
  tools: string[];
}

/**
 * Payload emitted when worker output includes an `agent_signals` block.
 */
export interface TraceAgentSignalsEventPayload {
  confidence: number | null;
  filesRead: string[];
  filesWritten: string[];
  toolsUsed: string[];
  approach: string | null;
  blockers: string | null;
  includesToolsUsedField: boolean;
}

/**
 * Payload emitted for summarized thinking-block metrics.
 */
export interface TraceThinkingEventPayload {
  thinkingBlocksCount: number;
  totalThinkingChars: number;
}

/**
 * Structured worker-output data consumed by trace event emitters.
 */
export interface ParsedTraceWorkerOutput {
  agentSignals: TraceAgentSignalsEventPayload | null;
  toolCalls: string[];
  thinking: TraceThinkingEventPayload | null;
}

/**
 * Reads per-phase artifact folders and returns a sorted, normalized artifact list.
 *
 * Missing metadata or malformed fields are skipped so callers can operate on a
 * stable shape without additional guards.
 */
export function collectTracePhaseArtifacts(
  artifactContext: ArtifactRunContext,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): TracePhaseArtifact[] {
  const entries = fileSystem.readdir(artifactContext.rootDir);
  const phases: TracePhaseArtifact[] = [];

  for (const entry of entries) {
    // Each phase is expected to be represented as a directory entry.
    if (!entry.isDirectory) {
      continue;
    }

    const phaseDir = pathOperations.join(artifactContext.rootDir, entry.name);
    const metadataPath = pathOperations.join(phaseDir, "metadata.json");
    if (!fileSystem.exists(metadataPath)) {
      continue;
    }

    // Ignore malformed metadata files instead of failing collection.
    const metadata = parseJson<TracePhaseMetadata>(fileSystem.readText(metadataPath));
    if (!metadata || !Number.isInteger(metadata.sequence) || typeof metadata.phase !== "string") {
      continue;
    }

    const stdout = metadata.stdoutFile
      ? readTraceArtifactText(pathOperations.join(phaseDir, metadata.stdoutFile), fileSystem)
      : "";
    const stderr = metadata.stderrFile
      ? readTraceArtifactText(pathOperations.join(phaseDir, metadata.stderrFile), fileSystem)
      : "";

    phases.push({
      sequence: metadata.sequence,
      phase: metadata.phase,
      startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : null,
      completedAt: typeof metadata.completedAt === "string" ? metadata.completedAt : null,
      durationMs: computeDurationMs(metadata.startedAt, metadata.completedAt),
      command: Array.isArray(metadata.command) ? metadata.command.filter((value): value is string => typeof value === "string") : [],
      exitCode: typeof metadata.exitCode === "number" || metadata.exitCode === null ? metadata.exitCode : null,
      outputCaptured: Boolean(metadata.outputCaptured),
      stdout,
      stderr,
    });
  }

  // Keep output deterministic for consumers and formatted trace sections.
  phases.sort((a, b) => a.sequence - b.sequence);
  return phases;
}

/**
 * Formats a concise bullet list of phase timing information for trace prompts.
 */
export function formatPhaseTimingsForTrace(phases: TracePhaseArtifact[]): string {
  if (phases.length === 0) {
    return "(no phase metadata available)";
  }

  return phases
    .map((phase) => {
      const startedAt = phase.startedAt ?? "unknown";
      const completedAt = phase.completedAt ?? "unknown";
      return `- #${phase.sequence} ${phase.phase}: ${phase.durationMs}ms (started: ${startedAt}, completed: ${completedAt})`;
    })
    .join("\n");
}

/**
 * Formats phase command/output data as markdown sections for trace prompts.
 */
export function formatPhaseOutputsForTrace(phases: TracePhaseArtifact[]): string {
  if (phases.length === 0) {
    return "(no phase output artifacts available)";
  }

  return phases
    .map((phase) => {
      const command = phase.command.length > 0 ? phase.command.join(" ") : "(unknown)";
      const stdout = phase.stdout.trim().length > 0 ? phase.stdout : "(empty)";
      const stderr = phase.stderr.trim().length > 0 ? phase.stderr : "(empty)";
      return [
        `### Phase ${phase.sequence}: ${phase.phase}`,
        `- Command: ${command}`,
        `- Exit code: ${String(phase.exitCode)}`,
        `- Output captured: ${String(phase.outputCaptured)}`,
        "- Stdout:",
        "```text",
        stdout,
        "```",
        "- Stderr:",
        "```text",
        stderr,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Parses each phase stdout payload and aggregates discovered signals,
 * thinking blocks, and tool usage.
 */
export function summarizePhaseAnalyses(phases: TracePhaseArtifact[]): PhaseAnalysisSummary {
  const signals: Array<{ phase: string; sequence: number; values: Record<string, string> }> = [];
  const thinkingBlocks: Array<{ phase: string; sequence: number; content: string }> = [];
  const toolSet = new Set<string>();

  for (const phase of phases) {
    if (phase.stdout.length === 0) {
      continue;
    }

    // Reuse the shared worker parser so analysis handling stays consistent.
    const analysis = parseWorkerOutput(phase.stdout);
    if (analysis.agent_signals) {
      signals.push({
        phase: phase.phase,
        sequence: phase.sequence,
        values: analysis.agent_signals,
      });
    }

    for (const block of analysis.thinking_blocks) {
      thinkingBlocks.push({
        phase: phase.phase,
        sequence: phase.sequence,
        content: block.content,
      });
    }

    for (const tool of analysis.tool_calls) {
      toolSet.add(tool);
    }
  }

  return {
    signals,
    thinkingBlocks,
    // Convert to a plain array for prompt rendering and event payloads.
    tools: [...toolSet],
  };
}

/**
 * Formats parsed agent signals by phase for markdown output.
 */
export function formatAgentSignalsForTrace(
  signals: Array<{ phase: string; sequence: number; values: Record<string, string> }>,
): string {
  if (signals.length === 0) {
    return "(no agent signals captured)";
  }

  return signals
    .map((signal) => {
      const lines = Object.entries(signal.values)
        .map(([key, value]) => `  - ${key}: ${value}`)
        .join("\n");
      return `- Phase #${signal.sequence} (${signal.phase}):\n${lines}`;
    })
    .join("\n");
}

/**
 * Formats thinking blocks in stable markdown sections with phase attribution.
 */
export function formatThinkingBlocksForTrace(
  blocks: Array<{ phase: string; sequence: number; content: string }>,
): string {
  if (blocks.length === 0) {
    return "(no thinking blocks captured)";
  }

  return blocks
    .map((block, index) => [
      `### Thinking ${index + 1} (phase #${block.sequence}, ${block.phase})`,
      "```text",
      block.content,
      "```",
    ].join("\n"))
    .join("\n\n");
}

/**
 * Formats a simple markdown bullet list of tool identifiers.
 */
export function formatToolUsageForTrace(tools: string[]): string {
  if (tools.length === 0) {
    return "(no tools reported by worker output parser)";
  }

  return tools.map((tool) => `- ${tool}`).join("\n");
}

/**
 * Extracts and validates an `analysis.summary` fenced block from worker stdout.
 *
 * Returns `null` when the block is missing or does not parse into the expected
 * shape.
 */
export function parseAnalysisSummaryFromWorkerOutput(stdout: string): AnalysisSummaryPayload | null {
  const match = stdout.match(/```analysis\.summary\s*([\s\S]*?)```/);
  if (!match) {
    return null;
  }

  const parsed = parseJson<Record<string, unknown>>(match[1] ?? "");
  if (!parsed) {
    return null;
  }

  return {
    task_complexity: asEnum(parsed.task_complexity, ["low", "medium", "high", "critical"], "medium"),
    execution_quality: asEnum(parsed.execution_quality, ["clean", "minor_issues", "significant_issues", "failed"], "minor_issues"),
    direction_changes: asNonNegativeInt(parsed.direction_changes),
    modules_touched: asStringArray(parsed.modules_touched),
    wasted_effort_pct: asNonNegativeInt(parsed.wasted_effort_pct),
    key_decisions: asStringArray(parsed.key_decisions),
    risk_flags: asStringArray(parsed.risk_flags),
    improvement_suggestions: asStringArray(parsed.improvement_suggestions),
    skill_gaps: asStringArray(parsed.skill_gaps),
    thinking_quality: asEnum(parsed.thinking_quality, ["clear", "scattered", "circular"], "scattered"),
    uncertainty_moments: asNonNegativeInt(parsed.uncertainty_moments),
  };
}

/**
 * Parses worker stdout into normalized event payloads used by trace telemetry.
 */
export function parseTraceWorkerOutputForEvents(stdout: string): ParsedTraceWorkerOutput {
  const analysis = parseWorkerOutput(stdout);

  let agentSignals: TraceAgentSignalsEventPayload | null = null;
  if (analysis.agent_signals) {
    // Confidence is emitted as an integer-like string; normalize invalid values to null.
    const confidenceRaw = analysis.agent_signals.confidence?.trim();
    const confidence = confidenceRaw && /^\d+$/.test(confidenceRaw)
      ? Number.parseInt(confidenceRaw, 10)
      : null;
    // CSV fields are optional and may include whitespace-only entries.
    const splitCsv = (value: string | undefined): string[] => value
      ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      : [];
    const approachRaw = analysis.agent_signals.approach?.trim();
    const blockersRaw = analysis.agent_signals.blockers?.trim();

    agentSignals = {
      confidence,
      filesRead: splitCsv(analysis.agent_signals.files_read),
      filesWritten: splitCsv(analysis.agent_signals.files_written),
      toolsUsed: splitCsv(analysis.agent_signals.tools_used),
      approach: approachRaw && approachRaw.length > 0 ? approachRaw : null,
      blockers: blockersRaw && blockersRaw.length > 0 ? blockersRaw : null,
      includesToolsUsedField: Object.prototype.hasOwnProperty.call(analysis.agent_signals, "tools_used"),
    };
  }

  let thinking: TraceThinkingEventPayload | null = null;
  if (analysis.thinking_blocks.length > 0) {
    thinking = {
      thinkingBlocksCount: analysis.thinking_blocks.length,
      // Aggregate size to provide a lightweight signal of reasoning verbosity.
      totalThinkingChars: analysis.thinking_blocks.reduce((sum, block) => sum + block.content.length, 0),
    };
  }

  return {
    agentSignals,
    toolCalls: analysis.tool_calls,
    thinking,
  };
}

// Reads artifact text defensively and falls back to an empty string when unavailable.
function readTraceArtifactText(filePath: string, fileSystem: FileSystem): string {
  if (!fileSystem.exists(filePath)) {
    return "";
  }

  try {
    return fileSystem.readText(filePath);
  } catch {
    return "";
  }
}
