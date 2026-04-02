import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ConfigDirPort,
  type ConfigDirResult,
} from "../../domain/ports/config-dir-port.js";

/**
 * Creates a filesystem-backed adapter that resolves the nearest config directory.
 *
 * The resolver walks upward from the provided start directory until it finds
 * `CONFIG_DIR_NAME` or reaches the filesystem root.
 *
 * @returns A config directory port implementation for local filesystem lookup.
 */
export function createConfigDirAdapter(): ConfigDirPort {
  return {
    /**
     * Resolves the nearest configuration directory by traversing ancestor paths.
     *
     * Starts from `startDir`, checks each level for `CONFIG_DIR_NAME`, and returns
     * `undefined` when no matching directory exists before reaching filesystem root.
     *
     * @param startDir Directory to begin upward traversal from.
     * @returns The resolved config directory metadata, or `undefined` if not found.
     */
    resolve(startDir) {
      // Normalize the starting point so traversal always uses an absolute path.
      let currentDir = path.resolve(startDir);

      while (true) {
        // Check for the expected config directory in the current traversal level.
        const configDir = path.join(currentDir, CONFIG_DIR_NAME);
        if (fs.existsSync(configDir)) {
          // Return the discovered directory and mark it as implicitly resolved.
          const result: ConfigDirResult = {
            configDir,
            isExplicit: false,
          };
          return result;
        }

        // Move one level up; stop once traversal reaches the filesystem root.
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
          return undefined;
        }
        currentDir = parentDir;
      }
    },
  };
}
