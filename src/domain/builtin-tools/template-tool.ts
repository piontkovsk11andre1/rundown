import type { ToolHandlerFn } from "../ports/tool-handler-port.js";
import type { ProcessRunMode } from "../ports/process-runner.js";
import { buildTaskHierarchyTemplateVars, renderTemplate, type TemplateVars } from "../template.js";
import { parseUncheckedTodoLines } from "../todo-lines.js";
import { expandCliBlocksWithOptions } from "../cli-block-expansion.js";
import {
  mapTemplateCliFailureToExitCode,
  TemplateCliBlockExecutionError,
  withTemplateCliFailureAbort,
} from "../cli-block-handlers.js";

const NOOP_TRACE_WRITER = {
  write: () => {},
  flush: () => {},
};

/**
 * Built-in handler for `.md` template tools (the default tool-expansion behavior).
 *
 * Renders the tool's Markdown template with task context variables, executes
 * the worker, parses stdout for child TODO lines, and returns them for insertion.
 */
export function createTemplateToolHandler(template: string): ToolHandlerFn {
  return async (context) => {
    const source = context.source;

    const vars: TemplateVars = {
      ...context.templateVars,
      task: context.task.text,
      payload: context.payload,
      file: context.task.file,
      context: context.contextBefore,
      taskIndex: context.task.index,
      taskLine: context.task.line,
      source,
      ...buildTaskHierarchyTemplateVars(context.task),
    };
    const renderedPrompt = renderTemplate(template, vars);
    let prompt = renderedPrompt;

    if (context.cliBlockExecutor) {
      let cliExpansionFailureReason = "CLI fenced block in tool template exited non-zero.";
      const expansion = await expandCliBlocksWithOptions({
        content: renderedPrompt,
        cliExpansionEnabled: context.cliExpansionEnabled ?? true,
        cliBlockExecutor: context.cliBlockExecutor,
        cwd: context.cwd,
        baseCliExpansionOptions: context.cliExecutionOptions,
        artifactContext: context.artifactContext,
        traceWriter: context.traceWriter ?? NOOP_TRACE_WRITER,
        cliTraceRunId: context.cliTraceRunId,
        nowIso: context.nowIso ?? (() => new Date().toISOString()),
        artifactPhaseLabel: "cli-tool-template",
        artifactPromptType: "tool-template",
        wrapExecutionOptions: (options) => withTemplateCliFailureAbort(options, "tool template"),
        onCliExpansionFailure: async (error) => {
          if (error instanceof TemplateCliBlockExecutionError) {
            const exitCodeLabel = error.exitCode === null ? "unknown" : String(error.exitCode);
            cliExpansionFailureReason = "`cli` fenced command failed in "
              + error.templateLabel
              + " (exit "
              + exitCodeLabel
              + "): "
              + error.command;
            return mapTemplateCliFailureToExitCode(error) ?? 1;
          }

          cliExpansionFailureReason = "Tool template CLI block expansion failed: " + toErrorMessage(error);
          return 1;
        },
      });

      if ("earlyExitCode" in expansion) {
        return {
          exitCode: expansion.earlyExitCode === 0 ? 1 : expansion.earlyExitCode,
          failureMessage: "Tool template CLI block expansion failed.",
          failureReason: cliExpansionFailureReason,
        };
      }

      prompt = expansion.expandedContent;
    }

    const runResult = await context.workerExecutor.runWorker({
      workerPattern: context.workerPattern,
      prompt,
      mode: context.mode as ProcessRunMode,
      trace: context.trace,
      cwd: context.cwd,
      env: context.executionEnv,
      configDir: context.configDir,
      artifactContext: context.artifactContext,
      artifactPhase: "execute",
    });

    if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
      return {
        exitCode: runResult.exitCode,
        failureMessage: "Tool expansion worker exited with code " + runResult.exitCode + ".",
        failureReason: "Tool expansion worker exited with a non-zero code.",
      };
    }

    if (context.showAgentOutput) {
      if (runResult.stdout) {
        context.emit({ kind: "text", text: runResult.stdout });
      }
      if (runResult.stderr) {
        context.emit({ kind: "stderr", text: runResult.stderr });
      }
    }

    const childTasks = parseUncheckedTodoLines(runResult.stdout);
    return {
      skipExecution: true,
      shouldVerify: false,
      childTasks,
    };
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}
