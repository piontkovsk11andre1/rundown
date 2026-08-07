import type {
  CommandExecutionOptions,
  CommandExecutor,
  CommandResult,
} from "./ports/command-executor.js";

/**
 * Represents a parsed `cli` fenced block in source Markdown.
 */
export interface CliBlock {
  // Zero-based source offset where the opening fence starts.
  startOffset: number;
  // Zero-based source offset where the closing fence line ends.
  endOffset: number;
  // Normalized executable command lines captured from the block body.
  commands: string[];
}

/**
 * Tracks the currently open fence while scanning line-by-line.
 */
interface ActiveFence {
  marker: "`" | "~";
  ticks: number;
  isCli: boolean;
  startOffset: number;
  commands: string[];
}

/**
 * Parsed metadata from a Markdown fenced code opening line.
 */
interface FenceInfo {
  marker: "`" | "~";
  ticks: number;
  info: string;
}

/**
 * Parses a potential opening fence line and returns normalized fence details.
 *
 * @param line Raw source line to inspect.
 * @returns Fence information when the line opens a fence; otherwise `null`.
 */
function parseFenceOpen(line: string): FenceInfo | null {
  const match = line.match(/^([`~])\1{2,}(.*)$/);
  if (!match) {
    return null;
  }

  const marker = match[1] as "`" | "~";
  const fullFence = match[0].match(/^([`~]{3,})/)?.[1] ?? "";

  return {
    marker,
    ticks: fullFence.length,
    info: match[2] ?? "",
  };
}

/**
 * Determines whether a line closes the currently active fence.
 *
 * @param line Current source line.
 * @param marker Fence marker character (` or ~).
 * @param ticks Minimum fence width required to close.
 * @returns `true` when the line is a valid matching closing fence.
 */
function isFenceClose(line: string, marker: "`" | "~", ticks: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < ticks) {
    return false;
  }

  const markerPattern = marker === "`" ? /^`+$/ : /^~+$/;
  return markerPattern.test(trimmed);
}

/**
 * Checks whether a fence info string targets the `cli` language tag.
 *
 * @param info Fence info string following the opening fence.
 * @returns `true` when the info string resolves to `cli`.
 */
function isCliFenceInfo(info: string): boolean {
  return /^cli[\t ]*$/.test(info);
}

/**
 * Identifies shell-style comment lines inside `cli` blocks.
 *
 * @param line Trimmed command line.
 * @returns `true` when the line should be ignored as a comment.
 */
function isCommentLine(line: string): boolean {
  return line.startsWith("#");
}

/**
 * Escapes XML-reserved characters in text content and attribute values.
 *
 * @param value Raw string value.
 * @returns XML-safe representation of the input value.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Converts a command execution result into the persisted XML fragment format.
 *
 * @param command Executed command text.
 * @param result Execution result returned by the command executor.
 * @returns XML containing command metadata and rendered output.
 */
function toXmlBlock(command: string, result: CommandResult): string {
  const hasNonZeroExit =
    typeof result.exitCode === "number" && result.exitCode !== 0;
  const isTimeout =
    result.exitCode === 124 && /timed out/i.test(result.stderr);
  const exitCodeAttribute = hasNonZeroExit
    ? ` exit_code=\"${escapeXml(isTimeout ? "timeout" : String(result.exitCode ?? -1))}\"`
    : "";
  const output = hasNonZeroExit
    ? isTimeout
      ? ["ERROR: command timed out", result.stderr].filter((entry) => entry.length > 0).join("\n")
      : result.stderr
    : result.stdout;
  const escapedOutput = escapeXml(output);

  return `<command${exitCodeAttribute}>${escapeXml(command)}</command>\n<output>\n${escapedOutput}\n</output>`;
}

/**
 * Extracts all top-level triple-fenced `cli` command blocks from Markdown text.
 *
 * @param source Full source document.
 * @returns Parsed CLI blocks with source offsets and executable commands.
 */
export function extractCliBlocks(source: string): CliBlock[] {
  const blocks: CliBlock[] = [];
  let offset = 0;
  let activeFence: ActiveFence | null = null;

  while (offset < source.length) {
    // Track the absolute start offset for the current line.
    const lineStart = offset;
    const nextLineFeed = source.indexOf("\n", offset);
    const lineEndWithTerminator =
      nextLineFeed === -1 ? source.length : nextLineFeed + 1;
    let line = source.slice(offset, lineEndWithTerminator);

    offset = lineEndWithTerminator;

    if (line.endsWith("\n")) {
      line = line.slice(0, -1);
    }

    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (activeFence) {
      if (isFenceClose(line, activeFence.marker, activeFence.ticks)) {
        if (activeFence.isCli) {
          blocks.push({
            startOffset: activeFence.startOffset,
            endOffset: lineStart + line.length,
            commands: activeFence.commands,
          });
        }

        activeFence = null;
        continue;
      }

      if (activeFence.isCli) {
        const trimmedLine = line.trim();
        // Ignore empty lines and shell comments for executable command capture.
        if (trimmedLine.length > 0 && !isCommentLine(trimmedLine)) {
          activeFence.commands.push(trimmedLine);
        }
      }

      continue;
    }

    const openedFence = parseFenceOpen(line);
    if (!openedFence) {
      continue;
    }

    activeFence = {
      marker: openedFence.marker,
      ticks: openedFence.ticks,
      isCli: openedFence.ticks === 3 && isCliFenceInfo(openedFence.info),
      startOffset: lineStart,
      commands: [],
    };
  }

  if (activeFence?.isCli) {
    blocks.push({
      startOffset: activeFence.startOffset,
      endOffset: source.length,
      commands: activeFence.commands,
    });
  }

  return blocks;
}

/**
 * Executes commands from extracted `cli` blocks and replaces each block with XML output.
 *
 * @param source Original Markdown source.
 * @param executor Command execution adapter.
 * @param cwd Working directory used for command execution.
 * @param options Optional execution hooks and artifact context metadata.
 * @returns Source with each CLI block expanded to command and output XML.
 */
export async function expandCliBlocks(
  source: string,
  executor: CommandExecutor,
  cwd: string,
  options?: CommandExecutionOptions,
): Promise<string> {
  const blocks = extractCliBlocks(source);

  if (blocks.length === 0) {
    return source;
  }

  let expanded = "";
  let cursor = 0;
  let artifactCommandOrdinal = 0;

  for (const block of blocks) {
    // Preserve non-CLI content between previously expanded regions.
    expanded += source.slice(cursor, block.startOffset);
    cursor = block.endOffset;

    const commandBlocks: string[] = [];

    for (const command of block.commands) {
      artifactCommandOrdinal += 1;
      const startedAt = Date.now();
      // Pass per-command ordinal metadata only when artifact context is enabled.
      const executionOptions = options?.artifactContext
        ? {
          ...options,
          artifactCommandOrdinal,
        }
        : options;
      const result = await executor.execute(command, cwd, executionOptions);
      const durationMs = Math.max(0, Date.now() - startedAt);
      await options?.onCommandExecuted?.({
        command,
        exitCode: result.exitCode,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        durationMs,
      });
      commandBlocks.push(toXmlBlock(command, result));
    }

    expanded += commandBlocks.join("\n\n");
  }

  expanded += source.slice(cursor);

  return expanded;
}
