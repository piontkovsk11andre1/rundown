import type { TemplateVarsLoaderPort } from "../../domain/ports/template-vars-loader-port.js";
import { loadTemplateVarsFile } from "../template-vars-io.js";

export function createFsTemplateVarsLoaderAdapter(): TemplateVarsLoaderPort {
  return {
    load(filePath, cwd) {
      return loadTemplateVarsFile(filePath, cwd);
    },
  };
}