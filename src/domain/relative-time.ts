/**
 * Formats an ISO timestamp into a concise relative-time label (for example,
 * "just now", "5m ago", or "in 2h") using the provided reference time.
 *
 * Returns the original input string when the timestamp cannot be parsed.
 */
export function formatRelativeTimestamp(now: Date, isoString: string): string {
  // Parse the candidate timestamp once and fall back gracefully on invalid input.
  const targetMs = Date.parse(isoString);
  if (!Number.isFinite(targetMs)) {
    return isoString;
  }

  // Compute elapsed time relative to the caller-supplied clock.
  const diffMs = now.getTime() - targetMs;
  // Collapse tiny differences into a stable, human-friendly phrase.
  if (Math.abs(diffMs) < 5_000) {
    return "just now";
  }

  // Determine direction (past vs. future) and derive coarse time units.
  const future = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const minutes = Math.floor(absMs / 60_000);
  const hours = Math.floor(absMs / 3_600_000);
  const days = Math.floor(absMs / 86_400_000);

  // Prefer seconds for intervals shorter than one minute.
  if (minutes < 1) {
    const seconds = Math.max(1, Math.floor(absMs / 1_000));
    return formatRelativeUnit(seconds, "s", future);
  }

  // Use minute precision up to one hour.
  if (hours < 1) {
    return formatRelativeUnit(minutes, "m", future);
  }

  // Use hour precision up to one day.
  if (days < 1) {
    return formatRelativeUnit(hours, "h", future);
  }

  // Use day precision for intervals shorter than one month.
  if (days < 30) {
    return formatRelativeUnit(days, "d", future);
  }

  // Approximate longer ranges in months and years.
  const months = Math.floor(days / 30);
  if (months < 12) {
    return formatRelativeUnit(months, "mo", future);
  }

  const years = Math.floor(days / 365);
  return formatRelativeUnit(years, "y", future);
}

/**
 * Builds the final relative-time token for a numeric value and short unit.
 */
function formatRelativeUnit(value: number, unit: string, future: boolean): string {
  // Future values read as "in <value><unit>".
  if (future) {
    return `in ${value}${unit}`;
  }
  // Past values read as "<value><unit> ago".
  return `${value}${unit} ago`;
}
