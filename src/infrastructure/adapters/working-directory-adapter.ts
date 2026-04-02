import type { WorkingDirectoryPort } from "../../domain/ports/working-directory-port.js";

/**
 * Creates a working-directory adapter backed by the Node.js process runtime.
 *
 * @returns A `WorkingDirectoryPort` implementation that reports the current process directory.
 */
export function createWorkingDirectoryAdapter(): WorkingDirectoryPort {
  return {
    // Delegates directly to Node.js so callers always receive the active process directory.
    cwd() {
      return process.cwd();
    },
  };
}
