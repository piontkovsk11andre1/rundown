// Matches a fenced `rundown-trace` block and captures its inner content.
const TRACE_BLOCK_PATTERN = /```rundown-trace[\t ]*\r?\n([\s\S]*?)\r?\n```/;

/**
 * Extracts and parses the first `rundown-trace` fenced block from stdout.
 *
 * Each non-empty line inside the block is interpreted as `key: value`. Lines
 * without a valid separator or key are ignored to keep parsing resilient.
 *
 * @param stdout Full process output that may include a trace block.
 * @returns A key/value map when a trace block is present, otherwise `null`.
 */
export function parseTraceBlock(stdout: string): Record<string, string> | null {
  // Locate the first trace block in the provided output.
  const match = TRACE_BLOCK_PATTERN.exec(stdout);

  // Return null when the trace block is missing or empty.
  if (!match || !match[1]) {
    return null;
  }

  // Split the captured block into individual candidate entries.
  const lines = match[1].split(/\r?\n/);
  const parsed: Record<string, string> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Ignore blank lines to support spaced formatting.
    if (line.length === 0) {
      continue;
    }

    // The first colon separates key and value.
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    // Normalize the key and skip malformed entries.
    const key = line.slice(0, separatorIndex).trim();
    if (key.length === 0) {
      continue;
    }

    // Preserve the last value seen for duplicate keys.
    const value = line.slice(separatorIndex + 1).trim();
    parsed[key] = value;
  }

  return parsed;
}
