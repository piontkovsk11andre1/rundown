import fs from "node:fs";
import type { Task } from "../../domain/parser.js";
import type { ValidationSidecar } from "../../domain/ports/validation-sidecar.js";

export function createFsValidationSidecar(): ValidationSidecar {
  return {
    filePath(task) {
      return validationFilePath(task);
    },
    read(task) {
      const filePath = validationFilePath(task);
      try {
        return fs.readFileSync(filePath, "utf-8").trim();
      } catch {
        return null;
      }
    },
    remove(task) {
      const filePath = validationFilePath(task);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore missing sidecar files.
      }
    },
  };
}

function validationFilePath(task: Task): string {
  return `${task.file}.${task.index}.validation`;
}
