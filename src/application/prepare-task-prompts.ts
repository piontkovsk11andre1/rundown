import { getTraceInstructions } from "../domain/defaults.js";
import { extractCliBlocks } from "../domain/cli-block.js";
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
import { expandCliBlocksWithOptions } from "./cli-block-expansion.js";
import {
  createCachedCommandExecutor,
  createCachedCommandResultStore,
} from "./cached-command-executor.js";
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
import {
  formatTemplateVarsForPrompt,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import type { RunTaskDependencies } from "./run-task-execution.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

function getLineStartOffset(source: string, lineNumber: number): number {
  if (!Number.isInteger(lineNumber) || lineNumber <= 1) {
    return 0;
  }

  let currentLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) {
      continue;
    }

    currentLine += 1;
    if (currentLine === lineNumber) {
      return index + 1;
    }
  }

  return source.length;
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
  cwd: string;
  taskTemplateOverride?: string;
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
    cwd,
    taskTemplateOverride,
    cliExecutionOptions,
    artifactContext,
    traceWriter,
    cliBlockExecutor,
    nowIso,
    emit,
    onTemplateCliFailure,
  } = params;

  // Compute the selected-task boundary against raw source before any expansion.
  const selectedTaskStartOffset = getLineStartOffset(fileSource, task.line);

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
  const sourceCliBlocks = extractCliBlocks(fileSource);
  const sourceCommandCacheEligibility = sourceCliBlocks.flatMap((block) => {
    const shouldCacheBlockResult = block.endOffset < selectedTaskStartOffset;
    return block.commands.map(() => shouldCacheBlockResult);
  });
  const sourceExecutorDelegate = dependencies.cliBlockExecutor ?? cliBlockExecutor;
  const sharedCacheStore = dependencies.cliBlockExecutor && dependencies.cliBlockExecutor !== cliBlockExecutor
    ? createCachedCommandResultStore()
    : null;
  let sourceCliBlockExecutor = cliBlockExecutor;
  let reachedPhaseCliBlockExecutor = cliBlockExecutor;
  if (sharedCacheStore) {
    let sourceCommandOrdinal = 0;
    sourceCliBlockExecutor = createCachedCommandExecutor(sourceExecutorDelegate, sharedCacheStore, {
      shouldCacheResult: () => {
        const shouldCache = sourceCommandCacheEligibility[sourceCommandOrdinal] ?? false;
        sourceCommandOrdinal += 1;
        return shouldCache;
      },
    });
    reachedPhaseCliBlockExecutor = createCachedCommandExecutor(
      sourceExecutorDelegate,
      sharedCacheStore,
    );
  }
  // Count CLI blocks in each stage for dry-run reporting.
  const sourceCliBlockCount = sourceCliBlocks.length;
  const expandedSourceResult = await expandCliBlocksWithOptions({
    content: fileSource,
    cliExpansionEnabled,
    cliBlockExecutor: sourceCliBlockExecutor,
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
  const taskTemplate = taskTemplateOverride ?? templates.task;
  const templateVarsWithTrace: ExtraTemplateVars = {
    ...extraTemplateVars,
    userVariables:
      extraTemplateVars.userVariables ?? formatTemplateVarsForPrompt(extraTemplateVars),
    traceInstructions: getTraceInstructions(trace),
    ...buildMemoryTemplateVars({
      memoryMetadata: dependencies.memoryResolver?.resolve(task.file) ?? null,
    }),
  };
  const vars: TemplateVars = {
    ...templateVarsWithTrace,
    task: selectedExpandedTask.text,
    file: selectedExpandedTask.file,
    context: expandedContextBefore,
    taskIndex: selectedExpandedTask.index,
    taskLine: selectedExpandedTask.line,
    source: expandedSource,
    ...buildTaskHierarchyTemplateVars(selectedExpandedTask),
  };

  const renderedPrompt = renderTemplate(taskTemplate, vars);
  const taskTemplateCliBlockCount = extractCliBlocks(renderedPrompt).length;
  let prompt = renderedPrompt;
  // Expand CLI blocks in the task template and allow caller-defined failure handling.
  const expandedPromptResult = await expandCliBlocksWithOptions({
    content: renderedPrompt,
    cliExpansionEnabled,
    cliBlockExecutor: reachedPhaseCliBlockExecutor,
    cwd,
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
      cliBlockExecutor: reachedPhaseCliBlockExecutor,
      cwd,
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
