import fs from "node:fs";
import type { Task } from "../../domain/parser.js";
import type { VerificationStore } from "../../domain/ports/verification-store.js";

/**
 * Creates a filesystem-backed verification store that persists validation
 * sidecar files next to task source files.
 */
export function createFsVerificationStore(): VerificationStore {
  return {
    write(task, content) {
      // Resolve the deterministic sidecar path for the task validation output.
      const filePath = validationFilePath(task);
      // Persist validation text as UTF-8 so downstream readers receive plain text.
      fs.writeFileSync(filePath, content, "utf-8");
    },
    read(task) {
      // Resolve the deterministic sidecar path for the task validation output.
      const filePath = validationFilePath(task);
      try {
        // Normalize trailing whitespace to keep comparisons stable.
        return fs.readFileSync(filePath, "utf-8").trim();
      } catch {
        // Treat missing or unreadable sidecar files as absent verification data.
        return null;
      }
    },
    remove(task) {
      // Resolve the deterministic sidecar path for the task validation output.
      const filePath = validationFilePath(task);
      try {
        // Remove any existing verification sidecar file for this task.
        fs.unlinkSync(filePath);
      } catch {
        // Ignore missing sidecar files.
      }
    },
  };
}

/**
 * Computes the on-disk path used to store validation output for a task.
 */
function validationFilePath(task: Task): string {
  return `${task.file}.${task.index}.validation`;
}
