/**
 * Defines path utility operations required by the domain layer.
 */
export interface PathOperationsPort {
  /** Joins path segments using the platform-specific separator. */
  join(...parts: string[]): string;
  /** Resolves path segments into an absolute normalized path. */
  resolve(...parts: string[]): string;
  /** Returns the parent directory for the provided file path. */
  dirname(filePath: string): string;
  /** Computes a relative path from one location to another. */
  relative(from: string, to: string): string;
  /** Indicates whether the provided path is absolute. */
  isAbsolute(filePath: string): boolean;
}
