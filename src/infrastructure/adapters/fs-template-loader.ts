import fs from "node:fs";
import type { TemplateLoader } from "../../domain/ports/template-loader.js";

export function createFsTemplateLoader(): TemplateLoader {
  return {
    load(filePath) {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
    },
  };
}
