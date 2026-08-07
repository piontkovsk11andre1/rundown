import { expandCliBlocks } from "./cli-block.js";
import type {
  ArtifactRunContext,
  CommandExecutionOptions,
  CommandExecutor,
  TraceWriterPort,
} from "./ports/index.js";
import { withCliTrace } from "./cli-block-handlers.js";

export type ExpandCliBlocksWithOptionsResult =
  | { expandedContent: string }
  | { earlyExitCode: number };

export async function expandCliBlocksWithOptions(params: {
  content: string;
  cliExpansionEnabled: boolean;
  cliBlockExecutor: CommandExecutor;
  cwd: string;
  baseCliExpansionOptions: CommandExecutionOptions | undefined;
  artifactContext: ArtifactRunContext | null;
  traceWriter: TraceWriterPort;
  cliTraceRunId: string | undefined;
  nowIso: () => string;
  artifactPhaseLabel:
    | "cli-source"
    | "cli-task-template"
    | "cli-verify-template"
    | "cli-tool-template";
  artifactPromptType:
    | "source"
    | "task-template"
    | "verify-template"
    | "tool-template";
  wrapExecutionOptions: (
    options: CommandExecutionOptions | undefined,
  ) => CommandExecutionOptions | undefined;
  onCliExpansionFailure?: (error: unknown) => Promise<number | null>;
}): Promise<ExpandCliBlocksWithOptionsResult> {
  const {
    content,
    cliExpansionEnabled,
    cliBlockExecutor,
    cwd,
    baseCliExpansionOptions,
    artifactContext,
    traceWriter,
    cliTraceRunId,
    nowIso,
    artifactPhaseLabel,
    artifactPromptType,
    wrapExecutionOptions,
    onCliExpansionFailure,
  } = params;

  if (!cliExpansionEnabled) {
    return { expandedContent: content };
  }

  const optionsWithArtifactContext = artifactContext?.keepArtifacts
    ? {
      ...baseCliExpansionOptions,
      artifactContext,
      artifactPhase: "worker" as const,
      artifactPhaseLabel,
      artifactExtra: {
        ...(baseCliExpansionOptions?.artifactExtra ?? {}),
        promptType: artifactPromptType,
      },
    }
    : baseCliExpansionOptions;
  const optionsWithTrace = withCliTrace(
    optionsWithArtifactContext,
    traceWriter,
    cliTraceRunId,
    nowIso,
  );

  try {
    const expandedContent = await expandCliBlocks(
      content,
      cliBlockExecutor,
      cwd,
      wrapExecutionOptions(optionsWithTrace),
    );
    return { expandedContent };
  } catch (error) {
    if (onCliExpansionFailure) {
      const failureCode = await onCliExpansionFailure(error);
      if (failureCode !== null) {
        return { earlyExitCode: failureCode };
      }
    }
    throw error;
  }
}