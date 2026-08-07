import type { DirectoryOpenerPort } from "../../domain/ports/directory-opener-port.js";
import { openDirectory } from "../open-directory.js";

/**
 * Creates the infrastructure adapter that satisfies the directory opener port.
 *
 * The adapter delegates directly to the platform-aware `openDirectory`
 * implementation used by the infrastructure layer.
 */
export function createDirectoryOpenerAdapter(): DirectoryOpenerPort {
  return {
    // Expose the shared directory-opening implementation through the port.
    openDirectory,
  };
}
