import type { TemplateVarsLoaderPort } from "../../domain/ports/template-vars-loader-port.js";
import { loadTemplateVarsFile } from "../template-vars-io.js";

/**
 * Creates a filesystem-backed template variables loader adapter.
 *
 * @returns A template variables loader port implementation that resolves and reads template variable files from disk.
 */
export function createFsTemplateVarsLoaderAdapter(): TemplateVarsLoaderPort {
  return {
    // Delegate file loading to the shared infrastructure utility.
    load(filePath, cwd, configDir) {
      return loadTemplateVarsFile(filePath, cwd, configDir);
    },
  };
}
