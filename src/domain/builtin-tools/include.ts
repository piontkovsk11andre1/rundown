import type { ToolHandlerFn } from "../ports/tool-handler-port.js";

/**
 * Built-in include handler.
 *
 * Resolves the payload as a file path relative to the task's source file,
 * and returns `childFile` so the orchestrator can clone and execute it.
 * The actual file copy and sub-execution is handled by the orchestrator layer.
 */
export const includeHandler: ToolHandlerFn = async (context) => {
  const targetPath = context.payload.trim();
  if (targetPath.length === 0) {
    return {
      exitCode: 1,
      failureMessage: "Include tool requires a file path payload.",
      failureReason: "Include payload is empty.",
    };
  }

  const sourceDir = context.pathOperations.dirname(
    context.pathOperations.resolve(context.task.file),
  );
  const resolvedPath = context.pathOperations.resolve(sourceDir, targetPath);

  if (!context.fileSystem.exists(resolvedPath)) {
    return {
      exitCode: 1,
      failureMessage: "Include target does not exist: " + resolvedPath,
      failureReason: "Include target file not found.",
    };
  }

  return {
    skipExecution: true,
    shouldVerify: false,
    childFile: resolvedPath,
  };
};
