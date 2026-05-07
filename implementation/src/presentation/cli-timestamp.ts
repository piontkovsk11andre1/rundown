/**
 * Canonical human-readable timestamp format for CLI terminal rendering.
 */
export const CLI_TIMESTAMP_FORMAT = "Local ISO-8601 with numeric offset";

/**
 * Formats a Date/string value into local ISO-8601 with numeric offset for
 * CLI display.
 *
 * When the input string is not parseable as a date, the original value is
 * returned to keep output deterministic.
 */
export function formatCliTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return toLocalIsoTimestamp(value);
  }

  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) {
    return value;
  }

  return toLocalIsoTimestamp(new Date(parsedMs));
}

function toLocalIsoTimestamp(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  const milliseconds = String(value.getMilliseconds()).padStart(3, "0");

  const offsetMinutes = -value.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetAbsoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(offsetAbsoluteMinutes / 60)).padStart(2, "0");
  const offsetRemainderMinutes = String(offsetAbsoluteMinutes % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${offsetSign}${offsetHours}:${offsetRemainderMinutes}`;
}
