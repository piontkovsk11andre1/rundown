import type { ToolResolverPort, ToolDefinition } from "./ports/tool-resolver-port.js";

/**
 * A single resolved segment in a prefix chain.
 */
export interface PrefixSegment {
  tool: ToolDefinition;
  payload: string;
}

/**
 * Parsed prefix chain extracted from a task's text.
 *
 * Modifiers are context-patching tools applied left-to-right before the handler.
 * The handler is the terminal tool that performs the actual task action.
 * When no tool prefixes are detected the chain is empty and `remainingText`
 * holds the full original task text.
 */
export interface PrefixChain {
  modifiers: PrefixSegment[];
  handler?: PrefixSegment;
  remainingText: string;
}

export interface ForceModifierExtraction {
  isForce: boolean;
  maxAttempts: number;
  strippedText: string;
}

const DEFAULT_FORCE_ATTEMPTS = 2;

/**
 * Extracts a leading `force:` modifier from task text before full prefix-chain parsing.
 *
 * Parsing grammar (case-insensitive):
 * - `force: <payload>`
 * - `force: <attempts>, <payload>`
 *
 * Where:
 * - `<attempts>` is one or more decimal digits and is only parsed when followed by `,`.
 * - Without a comma (`force: 3`), `3` is treated as task text payload.
 * - Nested `force:` prefixes are not recursively extracted; only the first leading
 *   `force:` is handled and any additional `force:` remains in `strippedText`.
 */
export function extractForceModifier(
  taskText: string,
  toolResolver?: ToolResolverPort,
): ForceModifierExtraction {
  const trimmed = taskText.trim();
  const prefixMatch = trimmed.match(/^force\s*:\s*/i);
  if (!prefixMatch) {
    return {
      isForce: false,
      maxAttempts: DEFAULT_FORCE_ATTEMPTS,
      strippedText: trimmed,
    };
  }

  const forceTool = toolResolver?.resolve("force");
  if (forceTool && forceTool.kind !== "modifier") {
    return {
      isForce: false,
      maxAttempts: DEFAULT_FORCE_ATTEMPTS,
      strippedText: trimmed,
    };
  }

  const payload = trimmed.slice(prefixMatch[0].length).trim();
  const attemptsWithPayloadMatch = payload.match(/^(\d+)\s*,\s*(.*)$/s);
  if (!attemptsWithPayloadMatch) {
    return {
      isForce: true,
      maxAttempts: DEFAULT_FORCE_ATTEMPTS,
      strippedText: payload,
    };
  }

  const parsedAttempts = Number.parseInt(attemptsWithPayloadMatch[1], 10);
  if (!Number.isFinite(parsedAttempts) || parsedAttempts < 1) {
    return {
      isForce: true,
      maxAttempts: DEFAULT_FORCE_ATTEMPTS,
      strippedText: payload,
    };
  }

  return {
    isForce: true,
    maxAttempts: parsedAttempts,
    strippedText: attemptsWithPayloadMatch[2].trim(),
  };
}

/**
 * Extracts the first `toolName:` prefix from text, if it resolves to a known tool.
 */
function extractLeadingTool(
  text: string,
  toolResolver: ToolResolverPort,
): { tool: ToolDefinition; rest: string } | undefined {
  const profileEqualsMatch = text.match(/^profile\s*=\s*(.*)$/is);
  if (profileEqualsMatch) {
    const tool = toolResolver.resolve("profile");
    if (!tool) {
      return undefined;
    }

    return {
      tool,
      rest: (profileEqualsMatch[1] ?? "").trim(),
    };
  }

  const legacyProfileMatch = text.match(/^profile\s*:\s*(.*)$/is);
  if (legacyProfileMatch) {
    throw new Error("Invalid profile syntax: use profile=<name> (not profile: <name>).")
  }

  const delimiterIndex = text.indexOf(":");
  if (delimiterIndex <= 0) {
    return undefined;
  }

  const candidate = text.slice(0, delimiterIndex).trim();
  if (candidate.length === 0) {
    return undefined;
  }

  const tool = toolResolver.resolve(candidate);
  if (!tool) {
    return undefined;
  }

  return {
    tool,
    rest: text.slice(delimiterIndex + 1).trim(),
  };
}

function getKnownToolNameSet(toolResolver: ToolResolverPort): Set<string> {
  return new Set(
    toolResolver.listKnownToolNames()
      .map((toolName) => toolName.trim().toLowerCase())
      .filter((toolName) => toolName.length > 0),
  );
}

/**
 * Splits text at `, ` or `; ` boundaries only when the segment after the
 * delimiter starts with a known tool prefix (`toolName:`).
 *
 * Returns an array of raw text segments preserving internal commas/semicolons
 * that are not followed by a recognized tool name.
 */
function splitAtToolBoundaries(
  text: string,
  knownToolNames: ReadonlySet<string>,
): string[] {
  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let bestSplitIndex = -1;

    // Scan for `, ` or `; ` delimiters where the next word before `:` is a tool.
    for (let i = 0; i < remaining.length - 1; i++) {
      const ch = remaining[i];
      if ((ch === "," || ch === ";") && remaining[i + 1] === " ") {
        const after = remaining.slice(i + 2).trimStart();
        const profileEqualsBoundary = after.match(/^profile\s*=/i);
        if (profileEqualsBoundary) {
          if (knownToolNames.has("profile")) {
            bestSplitIndex = i;
            break;
          }
          continue;
        }

        const delimiterIndex = after.indexOf(":");
        if (delimiterIndex > 0) {
          const candidate = after.slice(0, delimiterIndex).trim();
          if (candidate.length > 0 && knownToolNames.has(candidate.toLowerCase())) {
            bestSplitIndex = i;
            break;
          }
        }
      }
    }

    if (bestSplitIndex === -1) {
      segments.push(remaining);
      break;
    }

    segments.push(remaining.slice(0, bestSplitIndex).trim());
    remaining = remaining.slice(bestSplitIndex + 2).trimStart();
  }

  return segments;
}

/**
 * Parses a task's text into a prefix chain of modifier and handler tools.
 *
 * Supports:
 * - Single prefix:    `verify: tests pass`
 * - Chained prefixes: `profile=fast, verify: tests pass`
 * - Mixed delimiters: `profile=fast; memory: capture notes`
 * - No prefix:        `plain task text` → empty chain
 *
 * Modifiers accumulate left-to-right. The first handler tool encountered
 * becomes the terminal handler; any text after it is the handler payload.
 * If no handler is found, the remaining text becomes the default task text.
 */
export function parsePrefixChain(taskText: string, toolResolver?: ToolResolverPort): PrefixChain {
  const trimmed = taskText.trim();

  if (!toolResolver) {
    return { modifiers: [], remainingText: trimmed };
  }

  const knownToolNames = getKnownToolNameSet(toolResolver);
  const segments = splitAtToolBoundaries(trimmed, knownToolNames);
  const modifiers: PrefixSegment[] = [];
  let handler: PrefixSegment | undefined;
  let remainingText = trimmed;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const extracted = extractLeadingTool(segment, toolResolver);

    if (!extracted) {
      // Not a tool — treat the rest (this segment + remaining segments) as plain text.
      remainingText = segments.slice(i).join(", ");
      break;
    }

    if (extracted.tool.kind === "modifier") {
      modifiers.push({ tool: extracted.tool, payload: extracted.rest });
      // If this is the last segment, remaining text is empty.
      remainingText = "";
      continue;
    }

    // Handler tool — terminal. Payload includes only this segment's rest.
    handler = { tool: extracted.tool, payload: extracted.rest };
    remainingText = extracted.rest;
    break;
  }

  return { modifiers, handler, remainingText };
}
