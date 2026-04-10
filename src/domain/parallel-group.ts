import { listBuiltinToolNames, resolveBuiltinTool } from "./builtin-tools/index.js";
import { parsePrefixChain } from "./prefix-chain.js";
import { classifyTaskIntent } from "./task-intent.js";
import type { ToolResolverPort } from "./ports/tool-resolver-port.js";

const PARALLEL_HANDLER_NAMES = new Set(["parallel", "concurrent", "par"]);

const BUILTIN_TOOL_RESOLVER: ToolResolverPort = {
  resolve: (toolName) => resolveBuiltinTool(toolName),
  listKnownToolNames: () => listBuiltinToolNames(),
};

/**
 * Returns true when task text resolves to a parallel-group control-flow task.
 *
 * This supports both direct prefixes (`parallel: setup`) and composed prefix
 * chains (`profile: fast, parallel: setup`).
 */
export function isParallelGroupTaskText(taskText: string, toolResolver?: ToolResolverPort): boolean {
  if (classifyTaskIntent(taskText, toolResolver).intent === "parallel-group") {
    return true;
  }

  const prefixChain = parsePrefixChain(taskText, toolResolver ?? BUILTIN_TOOL_RESOLVER);
  const handlerName = prefixChain.handler?.tool.name.trim().toLowerCase();
  return handlerName !== undefined && PARALLEL_HANDLER_NAMES.has(handlerName);
}
