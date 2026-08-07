import path from "node:path";
import type { PathOperationsPort } from "../../domain/ports/path-operations-port.js";

/**
 * Creates a `PathOperationsPort` adapter backed by Node.js path utilities.
 *
 * @returns Path operation helpers that normalize behavior through the domain port.
 */
export function createNodePathOperationsAdapter(): PathOperationsPort {
  // Expose the Node path API through the domain-specific port contract.
  return {
    join(...parts) {
      // Join path segments using platform-specific separators.
      return path.join(...parts);
    },
    resolve(...parts) {
      // Resolve segments into an absolute path from right to left.
      return path.resolve(...parts);
    },
    dirname(filePath) {
      // Extract the parent directory from the provided path.
      return path.dirname(filePath);
    },
    relative(from, to) {
      // Compute the relative path from one location to another.
      return path.relative(from, to);
    },
    isAbsolute(filePath) {
      // Determine whether the input path is already absolute.
      return path.isAbsolute(filePath);
    },
  };
}
