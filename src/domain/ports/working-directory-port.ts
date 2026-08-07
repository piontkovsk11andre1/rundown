/**
 * Exposes access to the process working directory for domain services.
 *
 * This port keeps consumers independent from direct runtime/environment calls
 * so adapters can provide deterministic behavior in tests.
 */
export interface WorkingDirectoryPort {
  // Returns the absolute current working directory path.
  cwd(): string;
}
