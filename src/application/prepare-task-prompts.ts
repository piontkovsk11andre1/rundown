import { getTraceInstructions } from "../domain/defaults.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { type Task, parseTasks } from "../domain/parser.js";
import {
  buildMemoryTemplateVars,
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import {
  withCliTrace,
  withSourceCliFailureWarning,
  withTemplateCliFailureAbort,
} from "./cli-block-handlers.js";
import {
  loadProjectTemplatesFromPorts,
  type ProjectTemplates,
} from "./project-templates.js";
import { findTaskByFallback } from "./task-context-resolution.js";
import type {
  ArtifactRunContext,
  CommandExecutionOptions,
  CommandExecutor,
  TraceWriterPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { RunTaskDependencies } from "./run-task-execution.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

type ExpandCliBlocksWithOptionsResult =
  | { expandedContent: string }
  | { earlyExitCode: number };

/**
 * Expands CLI blocks for a prompt/source payload while consistently applying
 * trace and artifact options and optionally mapping expansion failures to
 * an early exit code.
 */
async function expandCliBlocksWithOptions(params: {
  content: string;
  cliExpansionEnabled: boolean;
  cliBlockExecutor: CommandExecutor;
  cwd: string;
  baseCliExpansionOptions: CommandExecutionOptions | undefined;
  artifactContext: ArtifactRunContext | null;
  traceWriter: TraceWriterPort;
  cliTraceRunId: string | undefined;
  nowIso: () => string;
  artifactPhaseLabel: "cli-source" | "cli-task-template" | "cli-verify-template";
  artifactPromptType: "source" | "task-template" | "verify-template";
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
    // Skip expansion entirely when CLI blocks are disabled.
    return { expandedContent: content };
  }

  // Attach artifact metadata so CLI block outputs are grouped by phase and prompt type.
  const optionsWithArtifactContext = artifactContext?.keepArtifacts
    ? {
      ...baseCliExpansionOptions,
      artifactPhaseLabel,
      artifactExtra: { promptType: artifactPromptType },
    }
    : baseCliExpansionOptions;
  const optionsWithTrace = withCliTrace(
    optionsWithArtifactContext,
    traceWriter,
    cliTraceRunId,
    nowIso,
  );

  try {
    // Expand all embedded CLI blocks before templates are consumed downstream.
    const expandedContent = await expandCliBlocks(
      content,
      cliBlockExecutor,
      cwd,
      wrapExecutionOptions(optionsWithTrace),
    );
    return { expandedContent };
  } catch (error) {
    if (onCliExpansionFailure) {
      // Allow callers to convert template/source expansion failures into controlled exits.
      const failureCode = await onCliExpansionFailure(error);
      if (failureCode !== null) {
        return { earlyExitCode: failureCode };
      }
    }
    throw error;
  }
}

export interface PrepareTaskPromptsResult {
  expandedSource: string;
  expandedContextBefore: string;
  templates: ProjectTemplates;
  templateVarsWithTrace: ExtraTemplateVars;
  prompt: string;
  verificationPrompt: string;
  cliExecutionOptionsWithVerificationTemplateFailureAbort: CommandExecutionOptions | undefined;
  cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: CommandExecutionOptions | undefined;
  dryRunCliBlockCount: number;
}

/**
 * Builds the task and verification prompts used by execution mode.
 *
 * The function expands CLI blocks in the source and templates, resolves the
 * selected task against the expanded source, and returns prompt artifacts and
 * execution options needed by downstream execution and verification flows.
 */
export async function prepareTaskPrompts(params: {
  dependencies: RunTaskDependencies;
  task: Task;
  fileSource: string;
  sourceDir: string;
  shouldVerify: boolean;
  trace: boolean;
  extraTemplateVars: ExtraTemplateVars;
  cliExpansionEnabled: boolean;
  ignoreCliBlock: boolean;
  cliExecutionOptions: CommandExecutionOptions | undefined;
  artifactContext: ArtifactRunContext | null;
  traceWriter: TraceWriterPort;
  cliBlockExecutor: CommandExecutor;
  nowIso: () => string;
  emit: EmitFn;
  onTemplateCliFailure: (error: unknown) => Promise<number | null>;
}): Promise<PrepareTaskPromptsResult | { earlyExitCode: number }> {
  const {
    dependencies,
    task,
    fileSource,
    sourceDir,
    shouldVerify,
    trace,
    extraTemplateVars,
    cliExpansionEnabled,
    ignoreCliBlock,
    cliExecutionOptions,
    artifactContext,
    traceWriter,
    cliBlockExecutor,
    nowIso,
    emit,
    onTemplateCliFailure,
  } = params;

  const baseCliExpansionOptions = artifactContext?.keepArtifacts
    ? {
      ...cliExecutionOptions,
      artifactContext,
      artifactPhase: "worker" as const,
    }
    : cliExecutionOptions;
  const cliTraceRunId = artifactContext?.runId;
  const cliExecutionOptionsWithTrace = withCliTrace(
    cliExecutionOptions,
    traceWriter,
    cliTraceRunId,
    nowIso,
  );
  // Count CLI blocks in each stage for dry-run reporting.
  const sourceCliBlockCount = extractCliBlocks(fileSource).length;
  const expandedSourceResult = await expandCliBlocksWithOptions({
    content: fileSource,
    cliExpansionEnabled,
    cliBlockExecutor,
    cwd: sourceDir,
    baseCliExpansionOptions,
    artifactContext,
    traceWriter,
    cliTraceRunId,
    nowIso,
    artifactPhaseLabel: "cli-source",
    artifactPromptType: "source",
    wrapExecutionOptions: (options) => withSourceCliFailureWarning(options, emit),
  });
  if ("earlyExitCode" in expandedSourceResult) {
    return expandedSourceResult;
  }
  const expandedSource = expandedSourceResult.expandedContent;
  // Re-parse tasks from the expanded source so line-based context stays accurate.
  const expandedTasks = parseTasks(expandedSource, task.file);
  const expandedTask = findTaskByFallback(expandedTasks, {
    text: task.text,
    file: task.file,
    line: task.line,
    index: task.index,
    source: fileSource,
  });
  const selectedExpandedTask = expandedTask ?? task;
  // Build context with all lines before the selected task for template rendering.
  const expandedContextBefore = expandedSource
    .split("\n")
    .slice(0, Math.max(0, selectedExpandedTask.line - 1))
    .join("\n");

  // Load project-level task/verify templates and construct rendering variables.
  const templates = loadProjectTemplatesFromPorts(
    dependencies.configDir,
    dependencies.templateLoader,
    dependencies.pathOperations,
  );
  const templateVarsWithTrace: ExtraTemplateVars = {
    ...extraTemplateVars,
    traceInstructions: getTraceInstructions(trace),
    ...buildMemoryTemplateVars({
      memoryMetadata: dependencies.memoryResolver?.resolve(task.file) ?? null,
    }),
  };
  const vars: TemplateVars = {
    ...templateVarsWithTrace,
    task: task.text,
    file: task.file,
    context: expandedContextBefore,
    taskIndex: task.index,
    taskLine: task.line,
    source: expandedSource,
    ...buildTaskHierarchyTemplateVars(task),
  };

  const renderedPrompt = renderTemplate(templates.task, vars);
  const taskTemplateCliBlockCount = extractCliBlocks(renderedPrompt).length;
  let prompt = renderedPrompt;
  // Expand CLI blocks in the task template and allow caller-defined failure handling.
  const expandedPromptResult = await expandCliBlocksWithOptions({
    content: renderedPrompt,
    cliExpansionEnabled,
    cliBlockExecutor,
    cwd: dependencies.workingDirectory.cwd(),
    baseCliExpansionOptions,
    artifactContext,
    traceWriter,
    cliTraceRunId,
    nowIso,
    artifactPhaseLabel: "cli-task-template",
    artifactPromptType: "task-template",
    wrapExecutionOptions: (options) => withTemplateCliFailureAbort(options, "task template"),
    onCliExpansionFailure: onTemplateCliFailure,
  });
  if ("earlyExitCode" in expandedPromptResult) {
    return expandedPromptResult;
  }
  prompt = expandedPromptResult.expandedContent;
  // Only prepare verification prompt content when verification is enabled.
  const renderedVerificationPrompt = shouldVerify
    ? renderTemplate(templates.verify, vars)
    : "";
  const verificationTemplateCliBlockCount = shouldVerify
    ? extractCliBlocks(renderedVerificationPrompt).length
    : 0;
  let verificationPrompt = shouldVerify ? renderedVerificationPrompt : "";
  if (shouldVerify) {
    // Expand CLI blocks in the verification template using the same safeguards.
    const expandedVerificationPromptResult = await expandCliBlocksWithOptions({
      content: renderedVerificationPrompt,
      cliExpansionEnabled,
      cliBlockExecutor,
      cwd: dependencies.workingDirectory.cwd(),
      baseCliExpansionOptions,
      artifactContext,
      traceWriter,
      cliTraceRunId,
      nowIso,
      artifactPhaseLabel: "cli-verify-template",
      artifactPromptType: "verify-template",
      wrapExecutionOptions: (options) => withTemplateCliFailureAbort(options, "verify template"),
      onCliExpansionFailure: onTemplateCliFailure,
    });
    if ("earlyExitCode" in expandedVerificationPromptResult) {
      return expandedVerificationPromptResult;
    }
    verificationPrompt = expandedVerificationPromptResult.expandedContent;
  }
  const cliExecutionOptionsWithVerificationTemplateFailureAbort = withTemplateCliFailureAbort(
    cliExecutionOptions,
    "verification/repair template",
  );
  // Preserve trace instrumentation for verification/repair CLI execution paths.
  const cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace = withTemplateCliFailureAbort(
    cliExecutionOptionsWithTrace,
    "verification/repair template",
  );
  const dryRunCliBlockCount = ignoreCliBlock
    ? 0
    : sourceCliBlockCount + taskTemplateCliBlockCount + verificationTemplateCliBlockCount;

  return {
    expandedSource,
    expandedContextBefore,
    templates,
    templateVarsWithTrace,
    prompt,
    verificationPrompt,
    cliExecutionOptionsWithVerificationTemplateFailureAbort,
    cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
    dryRunCliBlockCount,
  };
}
