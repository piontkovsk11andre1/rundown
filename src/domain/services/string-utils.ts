const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
const DISALLOWED_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

/**
 * Sanitizes terminal-oriented output into deterministic plain text.
 *
 * - strips ANSI escape sequences
 * - normalizes CRLF to LF
 * - resolves carriage-return overwrite frames to the final visible text
 * - removes non-printable control characters (excluding LF and TAB)
 */
export function sanitizeTerminalText(value: string): string {
  const withoutAnsi = stripAnsi(value);
  const normalizedNewlines = withoutAnsi.replace(/\r\n/g, "\n");

  const resolvedLines = normalizedNewlines
    .split("\n")
    .map((line) => {
      const lastCarriageReturn = line.lastIndexOf("\r");
      const visible = lastCarriageReturn >= 0 ? line.slice(lastCarriageReturn + 1) : line;
      return visible.replace(DISALLOWED_CONTROL_PATTERN, "");
    });

  return resolvedLines.join("\n");
}
