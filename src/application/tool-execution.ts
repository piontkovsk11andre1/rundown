import type { PrefixChain } from "../domain/prefix-chain.js";
import type { ToolHandlerContext, ToolHandlerResult } from "../domain/ports/tool-handler-port.js";
import type { ToolDefinition } from "../domain/ports/tool-resolver-port.js";
import { insertSubitems } from "../domain/planner.js";
import type { TemplateVars } from "../domain/template.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

/**
 * Executes a parsed prefix chain: applies modifiers left-to-right,
 * then delegates to the handler tool (or returns default behavior signals).
 *
 * For JS tools with `handlerPath` that haven't been loaded yet, performs
 * the dynamic `import()` and caches the handler on the tool definition.
 */
export async function executeToolChain(
  chain: PrefixChain,
  baseContext: ToolHandlerContext,
  emit: EmitFn,
): Promise<ToolChainResult> {
  let context = { ...baseContext };

  // Apply modifiers left-to-right.
  for (const modifier of chain.modifiers) {
    let handler: ToolDefinition["handler"];
    try {
      handler = await resolveHandler(modifier.tool);
    } catch (error) {
      const toolFailure = normalizeToolResolutionFailure(error, modifier.tool, "modifier");
      return {
        kind: "execution-failed",
        executionFailureMessage: toolFailure.message,
        executionFailureRunReason: toolFailure.reason,
        executionFailureExitCode: 1,
      };
    }

    if (!handler) {
      return {
        kind: "execution-failed",
        executionFailureMessage: `Modifier tool "${modifier.tool.name}" has no handler.`,
        executionFailureRunReason: "Modifier tool missing handler.",
        executionFailureExitCode: 1,
      };
    }

    const modifierContext = { ...context, payload: modifier.payload };
    const result = await handler(modifierContext);

    if (result.exitCode != null && result.exitCode !== 0) {
      return {
        kind: "execution-failed",
        executionFailureMessage: result.failureMessage ?? `Modifier "${modifier.tool.name}" failed.`,
        executionFailureRunReason: result.failureReason ?? "Modifier tool failed.",
        executionFailureExitCode: result.exitCode,
      };
    }

    // Apply context modifications from modifier.
    if (result.contextModifications) {
      if (result.contextModifications.profile) {
        context = { ...context, modifierProfile: result.contextModifications.profile } as ToolHandlerContext & { modifierProfile?: string };
      }
      if (result.contextModifications.templateVars) {
        context = {
          ...context,
          templateVars: { ...context.templateVars, ...result.contextModifications.templateVars },
        };
      }
    }

    emit({ kind: "info", message: `Applied modifier: ${modifier.tool.name}` });
  }

  // Execute handler tool if present.
  if (chain.handler) {
    let handler: ToolDefinition["handler"];
    try {
      handler = await resolveHandler(chain.handler.tool);
    } catch (error) {
      const toolFailure = normalizeToolResolutionFailure(error, chain.handler.tool, "handler");
      return {
        kind: "execution-failed",
        executionFailureMessage: toolFailure.message,
        executionFailureRunReason: toolFailure.reason,
        executionFailureExitCode: 1,
      };
    }

    if (!handler) {
      return {
        kind: "execution-failed",
        executionFailureMessage: `Handler tool "${chain.handler.tool.name}" has no handler.`,
        executionFailureRunReason: "Handler tool missing handler.",
        executionFailureExitCode: 1,
      };
    }

    const handlerContext = { ...context, payload: chain.handler.payload };

    emit({ kind: "info", message: `Running tool: ${chain.handler.tool.name}` });
    const result = await handler(handlerContext);

    if (result.exitCode != null && result.exitCode !== 0) {
      return {
        kind: "execution-failed",
        executionFailureMessage: result.failureMessage ?? `Tool "${chain.handler.tool.name}" failed.`,
        executionFailureRunReason: result.failureReason ?? "Tool handler failed.",
        executionFailureExitCode: result.exitCode,
      };
    }

    // Handle child task insertion.
    if (result.childTasks && result.childTasks.length > 0) {
      const source = context.fileSystem.readText(context.task.file);
      const updatedSource = insertSubitems(source, context.task, result.childTasks);
      context.fileSystem.writeText(context.task.file, updatedSource);
      emit({
        kind: "info",
        message: "Inserted " + result.childTasks.length + " tool-generated child TODO item"
          + (result.childTasks.length === 1 ? "" : "s") + ".",
      });
    }

    return {
      kind: "tool-handled",
      skipExecution: result.skipExecution ?? false,
      shouldVerify: result.shouldVerify ?? false,
      ...(result.skipRemainingSiblings ? { skipRemainingSiblings: result.skipRemainingSiblings } : {}),
      childFile: result.childFile,
      childTaskCount: result.childTasks?.length ?? 0,
      modifierProfile: (context as ToolHandlerContext & { modifierProfile?: string }).modifierProfile,
    };
  }

  // No handler — modifiers only. Return context modifications for default pipeline.
  return {
    kind: "modifiers-only",
    modifierProfile: (context as ToolHandlerContext & { modifierProfile?: string }).modifierProfile,
    templateVars: context.templateVars,
  };
}

/**
 * Resolves the handler function for a tool definition.
 * For JS tools with `handlerPath`, performs lazy dynamic `import()`.
 */
async function resolveHandler(tool: ToolDefinition): Promise<ToolDefinition["handler"]> {
  if (tool.handler) {
    if (typeof tool.handler === "function") {
      return tool.handler;
    }
    throw createToolModuleValidationError(
      tool,
      "Tool has an invalid in-memory handler. Expected a function.",
      "Tool handler is not a function.",
    );
  }

  if (tool.handlerPath) {
    try {
      const module = await import(/* webpackIgnore: true */ tool.handlerPath);
      const handler = module.default ?? module.handler;
      if (typeof handler === "function") {
        // Cache for future calls.
        tool.handler = handler;
        return handler;
      }
      const exportedKeys = Object.keys(module);
      if (handler === undefined) {
        throw createToolModuleValidationError(
          tool,
          "Missing handler export. Expected a default export function"
            + " or a named export `handler` function."
            + " Found exports: " + (exportedKeys.length > 0 ? exportedKeys.join(", ") : "(none)"),
          "JavaScript tool module has no callable handler export.",
        );
      }

      throw createToolModuleValidationError(
        tool,
        "Invalid handler export type. Expected function but received " + describeValueType(handler) + ".",
        "JavaScript tool module exports a non-function handler.",
      );
    } catch (error) {
      if (isToolModuleValidationError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw createToolModuleValidationError(
        tool,
        "Failed to import module: " + message,
        "JavaScript tool module failed to load.",
      );
    }
  }

  return undefined;
}

function describeValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function createToolModuleValidationError(
  tool: ToolDefinition,
  detail: string,
  reason: string,
): Error & { toolFailureMessage: string; toolFailureReason: string } {
  const source = tool.handlerPath ? " at " + tool.handlerPath : "";
  const failureMessage = "Invalid JavaScript tool module for \""
    + tool.name + "\"" + source + ": " + detail;
  const error = new Error(failureMessage) as Error & { toolFailureMessage: string; toolFailureReason: string };
  error.toolFailureMessage = failureMessage;
  error.toolFailureReason = reason;
  return error;
}

function isToolModuleValidationError(
  error: unknown,
): error is Error & { toolFailureMessage: string; toolFailureReason: string } {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & {
    toolFailureMessage?: unknown;
    toolFailureReason?: unknown;
  };

  return typeof candidate.toolFailureMessage === "string"
    && typeof candidate.toolFailureReason === "string";
}

function normalizeToolResolutionFailure(
  error: unknown,
  tool: ToolDefinition,
  role: "modifier" | "handler",
): { message: string; reason: string } {
  if (isToolModuleValidationError(error)) {
    return {
      message: error.toolFailureMessage,
      reason: error.toolFailureReason,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    message: "Failed to resolve " + role + " tool \"" + tool.name + "\": " + message,
    reason: "Failed to resolve " + role + " tool module.",
  };
}

/**
 * Result of executing a tool chain.
 */
export type ToolChainResult =
  | {
    kind: "tool-handled";
    skipExecution: boolean;
    shouldVerify: boolean;
    skipRemainingSiblings?: {
      reason: string;
    };
    childFile?: string;
    childTaskCount: number;
    modifierProfile?: string;
  }
  | {
    kind: "modifiers-only";
    modifierProfile?: string;
    templateVars?: TemplateVars;
  }
  | {
    kind: "execution-failed";
    executionFailureMessage: string;
    executionFailureRunReason: string;
    executionFailureExitCode: number | null;
  };
