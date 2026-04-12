import type { ToolHandlerFn } from "../ports/tool-handler-port.js";
import { formatForLoopItemMetadataLine, getForCurrentValue, resolveForLoopItems } from "../for-loop.js";

/**
 * Built-in for-each loop handler.
 *
 * The full loop orchestration is handled by the application layer. The
 * built-in handler remains a control-flow marker that skips direct worker
 * execution and verification.
 */
export const forLoopHandler: ToolHandlerFn = async (context) => {
  const payload = context.payload.trim();
  if (payload.length === 0) {
    return {
      exitCode: 1,
      failureMessage: "For loop tool requires a non-empty payload.",
      failureReason: "For loop payload is empty.",
    };
  }

  if (context.task.children.length === 0) {
    return {
      exitCode: 1,
      failureMessage: "For loop task requires nested checkbox child tasks.",
      failureReason: "For loop task has no nested checkbox children.",
    };
  }

  const { items: bakedItems, source: itemSource } = resolveForLoopItems(context.task.subItems, payload);

  if (bakedItems.length === 0) {
    context.emit({ kind: "warn", message: "For loop resolved zero unique items; completing without iteration." });
    return {
      skipExecution: true,
      shouldVerify: false,
    };
  }

  const existingCurrent = getForCurrentValue(context.task.subItems);
  const metadataLines = bakedItems.map((item) => formatForLoopItemMetadataLine(item));

  context.emit({
    kind: "info",
    message: "For loop baked " + bakedItems.length + " unique items from " + itemSource + ": " + bakedItems.join(", "),
  });
  context.emit({ kind: "info", message: "For loop current item: " + (existingCurrent ?? bakedItems[0] ?? "") });

  return {
    skipExecution: true,
    shouldVerify: false,
    childTasks: metadataLines,
  };
};
