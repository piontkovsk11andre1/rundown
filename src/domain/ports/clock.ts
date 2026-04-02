/**
 * Provides access to current time values for domain services.
 *
 * This port decouples time retrieval from runtime globals so adapters can
 * supply deterministic timestamps during tests and simulations.
 */
export interface Clock {
  // Returns the current local date-time value.
  now(): Date;

  // Returns the current timestamp as an ISO-8601 string.
  nowIsoString(): string;
}
