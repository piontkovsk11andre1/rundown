/** Canonical unchecked TODO list line used across worker parsing flows. */
export type UncheckedTodoLine = string;

/**
 * Extracts unchecked Markdown TODO lines from arbitrary text.
 *
 * Accepts `-`, `*`, and `+` list markers and trims leading indentation.
 */
export function parseUncheckedTodoLines(source: string): UncheckedTodoLine[] {
  const lines = source.split(/\r?\n/);
  const taskPattern = /^\s*[-*+]\s+\[ \]\s+\S/;
  const fencePattern = /^\s*(`{3,}|~{3,})/;
  let openFence: { char: "`" | "~"; length: number } | null = null;

  return lines
    .filter((line) => {
      const fenceMatch = line.match(fencePattern);
      if (fenceMatch) {
        const marker = fenceMatch[1] ?? "";
        const char = marker[0] as "`" | "~";
        const length = marker.length;

        if (openFence === null) {
          openFence = { char, length };
          return false;
        }

        if (openFence.char === char && length >= openFence.length) {
          openFence = null;
          return false;
        }
      }

      if (openFence !== null) {
        return false;
      }

      return taskPattern.test(line);
    })
    .map((line) => line.replace(/^\s+/, ""));
}
