import { parseTraceBlock } from "./trace-parser.js";

/**
 * Structured analysis extracted from a worker stdout payload.
 */
export interface WorkerOutputAnalysis {
  /** Captured reasoning/thinking blocks discovered in stdout. */
  thinking_blocks: { content: string }[];
  /** Deduplicated list of tool identifiers reported by worker trace signals. */
  tool_calls: string[];
  /** Parsed key/value trace metadata emitted by the worker runtime. */
  agent_signals: Record<string, string> | null;
  /** Original stdout preserved for downstream inspection and debugging. */
  raw_stdout: string;
}

// Patterns that capture supported thinking-block formats in worker output.
const THINKING_BLOCK_PATTERNS = [
  /<thinking>([\s\S]*?)<\/thinking>/g,
  /```thinking[\t ]*\r?\n([\s\S]*?)\r?\n```/g,
  /```opencode-thinking[\t ]*\r?\n([\s\S]*?)\r?\n```/g,
] as const;

/**
 * Parses raw worker stdout into a normalized analysis structure.
 *
 * @param stdout Worker process stdout text.
 * @returns Parsed reasoning blocks, trace metadata, tool calls, and raw stdout.
 */
export function parseWorkerOutput(stdout: string): WorkerOutputAnalysis {
  const thinking_blocks = extractThinkingBlocks(stdout);
  const agent_signals = parseTraceBlock(stdout);
  const tool_calls = extractToolCalls(agent_signals);

  return {
    thinking_blocks,
    tool_calls,
    agent_signals,
    raw_stdout: stdout,
  };
}

/**
 * Extracts thinking blocks from stdout across all supported markup formats.
 *
 * @param stdout Worker process stdout text.
 * @returns Ordered list of non-empty thinking block contents.
 */
function extractThinkingBlocks(stdout: string): { content: string }[] {
  const blocks: { content: string }[] = [];

  // Preserve discovery order across all known block syntaxes.
  for (const pattern of THINKING_BLOCK_PATTERNS) {
    for (const match of stdout.matchAll(pattern)) {
      const content = match[1]?.trim();
      if (content && content.length > 0) {
        blocks.push({ content });
      }
    }
  }

  return blocks;
}

/**
 * Extracts a deduplicated list of tool call identifiers from agent signals.
 *
 * @param agentSignals Parsed trace metadata map, if present.
 * @returns Unique tool names in first-seen order.
 */
function extractToolCalls(agentSignals: Record<string, string> | null): string[] {
  const toolsValue = agentSignals?.tools_used;

  if (!toolsValue) {
    return [];
  }

  const seen = new Set<string>();
  const tools: string[] = [];

  // Keep stable ordering while removing empty and repeated entries.
  for (const rawTool of toolsValue.split(",")) {
    const tool = rawTool.trim();

    if (tool.length === 0 || seen.has(tool)) {
      continue;
    }

    seen.add(tool);
    tools.push(tool);
  }

  return tools;
}
