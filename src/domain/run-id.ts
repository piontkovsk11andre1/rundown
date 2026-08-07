// Maximum number of characters retained for compact run identifiers.
const COMPACT_RUN_ID_LENGTH = 16;

/**
 * Normalizes a run identifier to the compact display/storage format.
 *
 * Preserves short identifiers as-is and truncates longer values to the
 * standard compact length.
 *
 * @param runId Full run identifier value.
 * @returns Compact run identifier capped at the configured length.
 */
export function toCompactRunId(runId: string): string {
  // Keep IDs that already fit within the compact limit unchanged.
  if (runId.length <= COMPACT_RUN_ID_LENGTH) {
    return runId;
  }

  // Truncate oversized IDs to the configured compact length.
  return runId.slice(0, COMPACT_RUN_ID_LENGTH);
}
