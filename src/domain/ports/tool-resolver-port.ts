import type { ToolKind, ToolFrontmatter, ToolHandlerFn } from "./tool-handler-port.js";

/**
 * Resolved tool definition loaded from `.rundown/tools/`, built-in registry,
 * or a JavaScript handler module.
 */
export interface ToolDefinition {
  // Canonical tool name used as the task prefix.
  name: string;
  // Whether this tool is a modifier (context patcher) or handler (terminal executor).
  kind: ToolKind;
  // Absolute path to the resolved tool template file (`.md` tools).
  templatePath?: string;
  // Absolute path to the resolved JavaScript handler module (`.js` tools).
  handlerPath?: string;
  // Raw Markdown template content used to render the worker prompt.
  template?: string;
  // JavaScript handler function loaded via `import()` or built-in registration.
  handler?: ToolHandlerFn;
  // Behavioral flags parsed from YAML frontmatter or config overrides.
  frontmatter?: ToolFrontmatter;
}

/**
 * Resolves tool definitions for dynamic task prefix expansion.
 */
export interface ToolResolverPort {
  // Returns the tool definition for a known tool name, or `undefined`.
  resolve(toolName: string): ToolDefinition | undefined;
  // Returns the normalized set of known tool names for prefix-chain boundary parsing.
  listKnownToolNames(): readonly string[];
}
