import type { Clock } from "../../domain/ports/clock.js";

export function createSystemClock(): Clock {
  return {
    now() {
      return new Date();
    },
    nowIsoString() {
      return new Date().toISOString();
    },
  };
}
