import type { Clock } from "../../domain/ports/clock.js";

/**
 * Creates a clock adapter backed by the host system time.
 *
 * @returns A `Clock` implementation that provides current time values in `Date` and ISO string formats.
 */
export function createSystemClock(): Clock {
  return {
    // Returns the current wall-clock time as a `Date` instance.
    now() {
      return new Date();
    },
    // Returns the current wall-clock time encoded as an ISO-8601 string.
    nowIsoString() {
      return new Date().toISOString();
    },
  };
}
